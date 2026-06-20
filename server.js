import express from "express";
import https from "https";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOP  = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API   = "2026-04";

// ── Core HTTP helper using Node built-in https ──
function shopifyRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: SHOP,
      port: 443,
      path: `/admin/api/${API}/${urlPath}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Shopify ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error("Invalid JSON: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function shopifyGQL(query) {
  return shopifyRequest("POST", "graphql.json", { query });
}

// ── Express app ──
const app = express();

// ── WEBHOOK must be registered BEFORE express.json() ──
// express.json() consumes the raw body; webhook needs raw bytes
app.post("/webhooks/orders/create", express.raw({ type: "*/*" }), async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately to Shopify

  try {
    const order = JSON.parse(req.body.toString());
    const customerId = order.customer?.id;
    const orderId = order.id;
    const orderName = order.name;

    if (!customerId) {
      console.log(`Webhook: Order ${orderName} has no customer — skipping`);
      return;
    }

    console.log(`🔔 Webhook fired: Order ${orderName} (${orderId}) from customer ${customerId}`);

    // Get customer's last 90 days order history via REST
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const historyData = await shopifyRequest("GET",
      `orders.json?customer_id=${customerId}&status=any&created_at_min=${since}&limit=250&fields=id,name,financial_status`
    );

    const history = historyData.orders || [];
    console.log(`Customer ${customerId}: ${history.length} orders in last 90 days`);

    // Bad orders = voided or refunded, excluding current order
    const badOrders = history.filter(o =>
      String(o.id) !== String(orderId) &&
      (o.financial_status === "voided" || o.financial_status === "refunded")
    );
    const badCount = badOrders.length;
    const riskLevel = badCount >= 2 ? "high-risk" : badCount === 1 ? "medium-risk" : null;

    console.log(`Customer ${customerId}: ${badCount} bad orders → ${riskLevel || "safe"}`);

    if (!riskLevel) {
      console.log(`✅ Order ${orderName} — customer safe, no tag needed`);
      return;
    }

    // Tag customer profile
    const custData = await shopifyRequest("GET", `customers/${customerId}.json?fields=id,tags`);
    const existingCustTags = custData.customer?.tags
      ? custData.customer.tags.split(",").map(t => t.trim()).filter(Boolean)
      : [];
    const newCustTags = [riskLevel];
    if (badOrders.some(o => o.financial_status === "voided")) newCustTags.push("voided-order");
    if (badOrders.some(o => o.financial_status === "refunded")) newCustTags.push("frequent-returns");
    const mergedCustTags = [...new Set([...existingCustTags, ...newCustTags])];

    await shopifyRequest("PUT", `customers/${customerId}.json`, {
      customer: {
        id: customerId,
        tags: mergedCustTags.join(", "),
        note: `⚠️ Auto-flagged: ${badCount} bad order(s) in 90 days: ${badOrders.map(o => o.name).join(", ")}`,
      },
    });

    // Tag the new order
    const orderTag = riskLevel === "high-risk"
      ? "Smart Returns - High Risk Order"
      : "Smart Returns - Medium Risk Order";

    const orderData = await shopifyRequest("GET", `orders/${orderId}.json?fields=id,tags`);
    const existingOrderTags = orderData.order?.tags
      ? orderData.order.tags.split(",").map(t => t.trim()).filter(Boolean)
      : [];

    if (!existingOrderTags.includes(orderTag)) {
      await shopifyRequest("PUT", `orders/${orderId}.json`, {
        order: { id: orderId, tags: [...existingOrderTags, orderTag].join(", ") },
      });
    }

    console.log(`🚨 Auto-tagged ${orderName} as "${orderTag}" — ${badCount} bad prior orders`);

  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Health ──
app.get("/health", (req, res) => {
  res.json({ status: "ok", shop: SHOP, tokenSet: !!TOKEN });
});

// ── Orders ──
app.get("/api/orders", async (req, res) => {
  try {
    const data = await shopifyGQL(`{
      orders(first: 50, query: "status:any") {
        edges { node {
          id name createdAt
          displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount } }
          customer { id legacyResourceId }
          lineItems(first: 10) { edges { node {
            id title variantTitle quantity
            originalUnitPriceSet { shopMoney { amount } }
          }}}
        }}
      }
    }`);

    if (data.errors) throw new Error(data.errors[0].message);

    const orders = data.data.orders.edges.map(({ node: o }) => ({
      id:                 o.id.replace("gid://shopify/Order/", ""),
      name:               o.name,
      created_at:         o.createdAt,
      customer_id:        o.customer?.legacyResourceId || null,
      financial_status:   (o.displayFinancialStatus || "").toLowerCase().replace(/_/g, " "),
      fulfillment_status: (o.displayFulfillmentStatus || "unfulfilled").toLowerCase().replace(/_/g, " "),
      total_price:        o.totalPriceSet?.shopMoney?.amount || "0",
      line_items:         o.lineItems.edges.map(({ node: li }) => ({
        id:            li.id.replace("gid://shopify/LineItem/", ""),
        title:         li.title,
        variant_title: li.variantTitle,
        quantity:      li.quantity,
        price:         li.originalUnitPriceSet?.shopMoney?.amount || "0",
      })),
    }));
    res.json(orders);
  } catch (e) {
    console.error("Orders error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Create Return ──
app.post("/api/returns", async (req, res) => {
  const { orderId, lineItems, reason, notifyCustomer } = req.body;
  try {
    const data = await shopifyRequest("POST", `orders/${orderId}/refunds.json`, {
      refund: {
        notify: notifyCustomer ?? true,
        note: reason || "Customer return",
        refund_line_items: (lineItems || []).map(li => ({
          line_item_id: li.id,
          quantity: li.quantity,
          restock_type: "no_restock",
        })),
      },
    });
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    res.json(data.refund);
  } catch (e) {
    console.error("Return error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Scan customers: 3-month order history → smart risk tagging ──
app.post("/api/scan-high-risk", async (req, res) => {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all orders — NO customer PII fields, only ID
    const data = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since.split("T")[0]}'") {
        edges { node {
          id
          name
          displayFinancialStatus
          createdAt
          customer { legacyResourceId }
          refunds { id }
        }}
      }
    }`);

    if (data.errors) throw new Error(data.errors[0].message);

    const orders = data.data.orders.edges.map(e => e.node);

    // Group by customer — count voided + refunded orders per customer
    const customerMap = {};
    for (const order of orders) {
      if (!order.customer) continue;
      const cid = order.customer.legacyResourceId;
      if (!customerMap[cid]) {
        customerMap[cid] = {
          customerId: cid,
          name: `Customer ${cid}`,
          email: "",
          totalOrders: 0,
          voidedCount: 0,
          refundedCount: 0,
          badOrders: [],
        };
      }
      customerMap[cid].totalOrders++;
      const status = (order.displayFinancialStatus || "").toLowerCase();
      if (status === "voided") {
        customerMap[cid].voidedCount++;
        customerMap[cid].badOrders.push(order.name);
      }
      // Only count refunded if NOT already counted as voided
      if ((status === "refunded" || order.refunds?.length > 0) && status !== "voided") {
        customerMap[cid].refundedCount++;
        customerMap[cid].badOrders.push(order.name);
      }
    }

    // Determine risk level per customer
    // HIGH RISK: 2+ unique bad orders in 3 months
    // MEDIUM RISK: 1 bad order
    const results = [];
    for (const [cid, c] of Object.entries(customerMap)) {
      // Deduplicate bad orders
      c.badOrders = [...new Set(c.badOrders)];
      const badCount = c.badOrders.length;
      if (badCount === 0) continue;

      let riskLevel = badCount >= 2 ? "high-risk" : "medium-risk";
      let tags = [riskLevel];
      if (c.voidedCount > 0) tags.push("voided-order");
      if (c.refundedCount > 0) tags.push("frequent-returns");

      // Get current tags and merge
      try {
        const custData = await shopifyRequest("GET", `customers/${cid}.json`);
        const existing = custData.customer?.tags
          ? custData.customer.tags.split(",").map(t => t.trim()).filter(Boolean)
          : [];

        const merged = [...new Set([...existing, ...tags])];

        // Update customer tags
        await shopifyRequest("PUT", `customers/${cid}.json`, {
          customer: {
            id: cid,
            tags: merged.join(", "),
            note: `⚠️ Auto-flagged: ${badCount} voided/refunded order(s) in last 90 days. Orders: ${[...new Set(c.badOrders)].join(", ")}`,
          },
        });

        // Also tag all NEW (non-bad) orders from this customer as high-risk
        const newOrders = orders.filter(o =>
          o.customer?.legacyResourceId === cid &&
          !c.badOrders.includes(o.name)
        );
        for (const newOrder of newOrders) {
          const orderId = newOrder.id.replace("gid://shopify/Order/", "");
          const existingOrder = await shopifyRequest("GET", `orders/${orderId}.json?fields=id,tags`);
          const existingOrderTags = existingOrder.order?.tags
            ? existingOrder.order.tags.split(",").map(t => t.trim()).filter(Boolean)
            : [];
          const riskTag = badCount >= 2 ? "Smart Returns - High Risk Order" : "Smart Returns - Medium Risk Order";
          if (!existingOrderTags.includes(riskTag)) {
            existingOrderTags.push(riskTag);
            await shopifyRequest("PUT", `orders/${orderId}.json`, {
              order: { id: orderId, tags: existingOrderTags.join(", ") },
            });
          }
        }

        // Fetch customer name via REST (allowed for custom apps)
        let customerName = `Customer ${cid}`;
        try {
          const cData = await shopifyRequest("GET", `customers/${cid}.json?fields=id,first_name,last_name`);
          const cn = cData.customer;
          if (cn) customerName = `${cn.first_name || ""} ${cn.last_name || ""}`.trim() || customerName;
        } catch(_) {}

        results.push({
          customerId: cid,
          name: customerName,
          email: "",
          totalOrders: c.totalOrders,
          voidedCount: c.voidedCount,
          refundedCount: c.refundedCount,
          badCount,
          badOrders: c.badOrders,
          riskLevel,
          tags: merged,
        });
      } catch (e) {
        console.warn(`Could not tag customer ${cid}:`, e.message);
      }
    }

    // Sort by risk: high first, then by bad order count
    results.sort((a, b) => {
      if (a.riskLevel === "high-risk" && b.riskLevel !== "high-risk") return -1;
      if (b.riskLevel === "high-risk" && a.riskLevel !== "high-risk") return 1;
      return (b.voidedCount + b.refundedCount) - (a.voidedCount + a.refundedCount);
    });

    res.json({ scanned: orders.length, flagged: results.length, customers: results });
  } catch (e) {
    console.error("Scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get high-risk customers from Shopify ──
app.get("/api/high-risk-customers", async (req, res) => {
  try {
    const data = await shopifyRequest("GET", `customers.json?tag=high-risk&limit=50`);
    res.json(data.customers || []);
  } catch (e) {
    console.error("High risk customers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Analytics ──
app.get("/api/analytics", async (req, res) => {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().split("T")[0];

    const data = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since}'") {
        edges { node {
          id
          refunds {
            note
            refundLineItems(first: 10) { edges { node {
              quantity
              subtotalSet { shopMoney { amount } }
              lineItem { title }
            }}}
          }
        }}
      }
    }`);

    if (data.errors) throw new Error(data.errors[0].message);

    const orders = data.data.orders.edges.map(e => e.node);
    let totalRefunds = 0, refundAmount = 0;
    const reasonMap = {}, productMap = {};

    for (const order of orders) {
      if (order.refunds?.length) {
        totalRefunds++;
        for (const ref of order.refunds) {
          const note = ref.note || "No reason given";
          reasonMap[note] = (reasonMap[note] || 0) + 1;
          for (const { node: rli } of ref.refundLineItems?.edges || []) {
            const title = rli.lineItem?.title || "Unknown";
            productMap[title] = (productMap[title] || 0) + rli.quantity;
            refundAmount += parseFloat(rli.subtotalSet?.shopMoney?.amount || 0);
          }
        }
      }
    }

    res.json({
      totalOrders:  orders.length,
      totalRefunds,
      returnRate:   orders.length ? ((totalRefunds / orders.length) * 100).toFixed(1) : "0",
      refundAmount: refundAmount.toFixed(2),
      topProducts:  Object.entries(productMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,qty])=>({name,qty})),
      topReasons:   Object.entries(reasonMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([reason,count])=>({reason,count})),
    });
  } catch (e) {
    console.error("Analytics error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// AUTO-TAG ENGINE
// Fires on every new order via Shopify webhook
// Checks customer's last 90 days → tags instantly
// ════════════════════════════════════════════════

// ── Core risk checker: given a customerId, analyse 90-day history ──
async function analyseCustomerRisk(customerId) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const data = await shopifyGQL(`{
    orders(first: 250, query: "customer_id:${customerId} created_at:>='${since}'") {
      edges { node {
        id
        name
        displayFinancialStatus
        refunds { id }
      }}
    }
  }`);

  if (data.errors) throw new Error(data.errors[0].message);
  const orders = data.data.orders.edges.map(e => e.node);

  let voidedCount = 0, refundedCount = 0;
  const badOrders = [];

  for (const o of orders) {
    const status = (o.displayFinancialStatus || "").toLowerCase();
    if (status === "voided") { voidedCount++; badOrders.push(o.name); }
    if (status === "refunded" || o.refunds?.length > 0) { refundedCount++; badOrders.push(o.name); }
  }

  const badCount = voidedCount + refundedCount;
  const riskLevel = badCount >= 2 ? "high-risk" : badCount === 1 ? "medium-risk" : null;

  return { totalOrders: orders.length, voidedCount, refundedCount, badCount, badOrders: [...new Set(badOrders)], riskLevel };
}

// ── Apply tags to customer + new order ──
async function applyRiskTags(customerId, newOrderId, risk) {
  const { riskLevel, badCount, badOrders, voidedCount, refundedCount } = risk;
  if (!riskLevel) return; // safe customer — no tagging

  // 1. Tag the customer profile
  const custData = await shopifyRequest("GET", `customers/${customerId}.json`);
  const existing = custData.customer?.tags
    ? custData.customer.tags.split(",").map(t => t.trim()).filter(Boolean)
    : [];

  const newTags = [riskLevel];
  if (voidedCount > 0) newTags.push("voided-order");
  if (refundedCount > 0) newTags.push("frequent-returns");
  const merged = [...new Set([...existing, ...newTags])];

  await shopifyRequest("PUT", `customers/${customerId}.json`, {
    customer: {
      id: customerId,
      tags: merged.join(", "),
      note: `⚠️ Auto-flagged by Smart Return Furor: ${badCount} voided/refunded order(s) in last 90 days. Bad orders: ${badOrders.join(", ")}`,
    },
  });

  // 2. Tag the new order
  const orderTag = riskLevel === "high-risk"
    ? "Smart Returns - High Risk Order"
    : "Smart Returns - Medium Risk Order";

  const orderData = await shopifyRequest("GET", `orders/${newOrderId}.json?fields=id,tags`);
  const existingOrderTags = orderData.order?.tags
    ? orderData.order.tags.split(",").map(t => t.trim()).filter(Boolean)
    : [];

  if (!existingOrderTags.includes(orderTag)) {
    existingOrderTags.push(orderTag);
    await shopifyRequest("PUT", `orders/${newOrderId}.json`, {
      order: { id: newOrderId, tags: existingOrderTags.join(", ") },
    });
  }

  console.log(`✅ Auto-tagged order ${newOrderId} and customer ${customerId} as ${riskLevel}`);
  return { riskLevel, orderTag, customerTags: merged };
}

// ── Webhook registered above before express.json() ──

// ── Register the webhook with Shopify (called once on startup) ──
async function registerWebhook() {
  const HOST = process.env.HOST;
  if (!HOST) { console.warn("⚠️ HOST not set — webhook not registered"); return; }

  try {
    // Check if webhook already exists
    const existing = await shopifyRequest("GET", "webhooks.json?topic=orders/create");
    const alreadyRegistered = existing.webhooks?.some(w =>
      w.address === `${HOST}/webhooks/orders/create`
    );

    if (alreadyRegistered) {
      console.log("✅ Webhook already registered");
      return;
    }

    // Register new webhook
    const result = await shopifyRequest("POST", "webhooks.json", {
      webhook: {
        topic: "orders/create",
        address: `${HOST}/webhooks/orders/create`,
        format: "json",
      },
    });
    console.log("✅ Webhook registered:", result.webhook?.id, "→", result.webhook?.address);
  } catch (e) {
    console.error("❌ Webhook registration failed:", e.message);
  }
}

// ── Health ──
app.get("/health", (req, res) => {
  res.json({ status: "ok", shop: SHOP, tokenSet: !!TOKEN });
});

// ── Webhook status endpoint ──
app.get("/api/webhook-status", async (req, res) => {
  try {
    const data = await shopifyRequest("GET", "webhooks.json?topic=orders/create");
    res.json({ webhooks: data.webhooks || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Smart Return Furor → https://${SHOP} on port ${PORT}`);
  // Register webhook after server starts
  await registerWebhook();
});
