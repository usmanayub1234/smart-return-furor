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

    // Fetch all orders in last 3 months with customer info
    const data = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since.split("T")[0]}'") {
        edges { node {
          id
          name
          displayFinancialStatus
          createdAt
          customer { id legacyResourceId firstName lastName email }
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
          name: `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim(),
          email: order.customer.email,
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
      if (status === "refunded" || order.refunds?.length > 0) {
        customerMap[cid].refundedCount++;
        customerMap[cid].badOrders.push(order.name);
      }
    }

    // Determine risk level per customer
    // HIGH RISK: 2+ voided/refunded in 3 months
    // MEDIUM RISK: 1 voided/refunded
    const results = [];
    for (const [cid, c] of Object.entries(customerMap)) {
      const badCount = c.voidedCount + c.refundedCount;
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

        results.push({
          customerId: cid,
          name: c.name,
          email: c.email,
          totalOrders: c.totalOrders,
          voidedCount: c.voidedCount,
          refundedCount: c.refundedCount,
          badOrders: [...new Set(c.badOrders)],
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Return Furor → https://${SHOP} on port ${PORT}`));
