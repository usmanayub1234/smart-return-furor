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
function shopifyRequest(method, urlPath, body = null, retryCount = 0) {
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
      res.on("end", async () => {
        try {
          const json = JSON.parse(data);

          // Handle rate limiting with automatic retry + backoff
          if (res.statusCode === 429 && retryCount < 5) {
            const retryAfter = parseFloat(res.headers["retry-after"]) || 2;
            const waitMs = Math.ceil(retryAfter * 1000) + retryCount * 500;
            console.warn(`⏳ Rate limited on ${urlPath} — retrying in ${waitMs}ms (attempt ${retryCount + 1}/5)`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
              const result = await shopifyRequest(method, urlPath, body, retryCount + 1);
              resolve(result);
            } catch (e) {
              reject(e);
            }
            return;
          }

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

// ── Tag hygiene: remove any conflicting Smart Returns risk tag before adding the correct one ──
const RISK_TAGS = ["Smart Returns - High Risk Order", "Smart Returns - Medium Risk Order"];
const CUST_RISK_TAGS = ["high-risk", "medium-risk"];

function applyCleanRiskTag(existingTags, newTag) {
  // Strip out any other Smart Returns risk tag, then add the correct one
  const cleaned = existingTags.filter(t => !RISK_TAGS.includes(t));
  cleaned.push(newTag);
  return [...new Set(cleaned)];
}

function applyCleanCustomerRiskTags(existingTags, newRiskTags) {
  // newRiskTags may include "high-risk"/"medium-risk" plus "voided-order"/"frequent-returns"
  const cleaned = existingTags.filter(t => !CUST_RISK_TAGS.includes(t));
  return [...new Set([...cleaned, ...newRiskTags])];
}

// ════════════════════════════════════════════════
// RISK CLASSIFICATION ENGINE
//
// Uses DELIVERY RATE (fulfilled orders ÷ total orders)
// combined with voided/cancelled COUNT:
//
// Delivery Rate Thresholds:
//   >= 70%        = Good delivery (safe-ish)
//   50% to <70%   = Medium delivery
//   < 50%         = Poor delivery (risky)
//
// Rules:
//   1 voided + delivery >= 70%  → SAFE
//   1 voided + delivery 50-70%  → MEDIUM RISK
//   1 voided + delivery < 50%   → HIGH RISK
//
//   2 voided + delivery >= 70%  → MEDIUM RISK
//   2 voided + delivery 50-70%  → MEDIUM RISK
//   2 voided + delivery < 50%   → HIGH RISK
//
//   3+ voided + delivery >= 70% → MEDIUM RISK
//   3+ voided + delivery 50-70% → MEDIUM RISK
//   3+ voided + delivery < 50%  → HIGH RISK
//
// deliveryRate = fulfilledOrders / totalOrders * 100
// ════════════════════════════════════════════════
function classifyRisk(totalOrders, badCount, deliveredCount) {
  if (badCount === 0 || totalOrders === 0) {
    return { riskLevel: null, deliveryRate: 100 };
  }

  const deliveryRate = totalOrders > 0 ? (deliveredCount / totalOrders) * 100 : 0;

  let riskLevel = null;

  if (badCount === 1) {
    if (deliveryRate >= 70)      riskLevel = null;          // Safe
    else if (deliveryRate >= 50) riskLevel = "medium-risk"; // Medium
    else                         riskLevel = "high-risk";   // High
  } else {
    // 2+ voided — delivery rate decides Medium vs High
    if (deliveryRate >= 50) riskLevel = "medium-risk"; // Medium
    else                    riskLevel = "high-risk";   // High
  }

  return { riskLevel, deliveryRate: Math.round(deliveryRate * 10) / 10 };
}

// ── Express app ──
const app = express();

// ── WEBHOOK must be registered BEFORE express.json() ──
// express.json() consumes the raw body; webhook needs raw bytes
app.post("/webhooks/orders/create", express.raw({ type: "*/*" }), async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately to Shopify

  let order, customerId, orderId, orderName;
  try {
    order = JSON.parse(req.body.toString());
    customerId = order.customer?.id;
    orderId = order.id;
    orderName = order.name;
  } catch (e) {
    console.error("Webhook: failed to parse order JSON:", e.message);
    return;
  }

  if (!customerId) {
    console.log(`Webhook: Order ${orderName} has no customer — skipping`);
    return;
  }

  console.log(`🔔 [${orderName}] Webhook fired for customer ${customerId}`);

  // ── Step 1: fetch order history — last 180 days ──
  // 180 days taake purane voided orders bhi count hon
  let history;
  try {
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const historyData = await shopifyRequest("GET",
      `orders.json?customer_id=${customerId}&status=any&created_at_min=${since}&limit=250&fields=id,name,financial_status,fulfillment_status,cancelled_at,created_at`
    );
    history = historyData.orders || [];
    console.log(`✓ [${orderName}] Step 1 OK — fetched ${history.length} orders (180 days): ${history.map(o=>`${o.name}:${o.financial_status}/${o.fulfillment_status||'?'}${o.cancelled_at?'(cancelled)':''}`).join(', ')}`);
  } catch (e) {
    console.error(`✗ [${orderName}] Step 1 FAILED (fetch history):`, e.message);
    return;
  }

  const totalOrders = history.length;
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Bad orders = voided/refunded/cancelled — ALWAYS count regardless of age
  const badOrders = history.filter(o =>
    String(o.id) !== String(orderId) &&
    (o.financial_status === "voided" || o.financial_status === "refunded" || !!o.cancelled_at)
  );

  // Delivered orders = paid OR (COD = pending + fulfilled)
  // Pakistan mein COD orders deliver hone ke baad bhi "pending" rehte hain
  const deliveredOrders = history.filter(o =>
    String(o.id) !== String(orderId) &&
    !o.cancelled_at &&
    (
      o.financial_status === "paid" ||
      (o.fulfillment_status === "fulfilled" && o.financial_status === "pending")
    )
  );

  // Pending = not bad, not delivered, and less than 24hrs old
  const pendingOrders = history.filter(o =>
    String(o.id) !== String(orderId) &&
    !badOrders.find(b => b.id === o.id) &&
    !deliveredOrders.find(d => d.id === o.id) &&
    new Date(o.created_at) >= cutoff24h
  );

  const badCount = badOrders.length;
  const deliveredCount = deliveredOrders.length;

  console.log(`📊 [${orderName}] Bad: ${badCount} | Delivered: ${deliveredCount} | Pending/skipped: ${pendingOrders.length}`);

  const { riskLevel, deliveryRate } = classifyRisk(badCount + deliveredCount, badCount, deliveredCount);

  console.log(`📊 [${orderName}] Delivery rate: ${deliveryRate}% → ${riskLevel || "safe"}`);

  if (!riskLevel) {
    console.log(`✅ [${orderName}] Customer safe — no tag needed`);
    return;
  }

  // ── Step 2: tag customer ──
  try {
    const custData = await shopifyRequest("GET", `customers/${customerId}.json?fields=id,tags`);
    const existingCustTags = custData.customer?.tags
      ? custData.customer.tags.split(",").map(t => t.trim()).filter(Boolean)
      : [];
    const newCustTags = [riskLevel];
    if (badOrders.some(o => o.financial_status === "voided" || !!o.cancelled_at)) newCustTags.push("voided-order");
    if (badOrders.some(o => o.financial_status === "refunded")) newCustTags.push("frequent-returns");
    const mergedCustTags = applyCleanCustomerRiskTags(existingCustTags, newCustTags);

    await shopifyRequest("PUT", `customers/${customerId}.json`, {
      customer: {
        id: customerId,
        tags: mergedCustTags.join(", "),
        note: `⚠️ Auto-flagged: ${badCount} bad order(s) in 90 days: ${badOrders.map(o => o.name).join(", ")}`,
      },
    });
    console.log(`✓ [${orderName}] Step 2 OK — customer tagged: ${mergedCustTags.join(", ")}`);
  } catch (e) {
    console.error(`✗ [${orderName}] Step 2 FAILED (tag customer ${customerId}):`, e.message);
    // continue to step 3 anyway — order tag is still useful even if customer tag failed
  }

  // ── Step 3: tag the order itself — ONLY if payment is pending ──
  try {
    // Get current order details to check payment status
    const orderData = await shopifyRequest("GET", `orders/${orderId}.json?fields=id,tags,financial_status`);
    const currentOrder = orderData.order;
    const paymentStatus = (currentOrder?.financial_status || "").toLowerCase();

    // Skip tagging if order is already paid — paise aa gaye, risk nahi
    if (paymentStatus === "paid") {
      console.log(`✅ [${orderName}] Step 3 SKIPPED — order already paid, no risk tag needed`);
      return;
    }

    const orderTag = riskLevel === "high-risk"
      ? "Smart Returns - High Risk Order"
      : "Smart Returns - Medium Risk Order";

    const existingOrderTags = currentOrder?.tags
      ? currentOrder.tags.split(",").map(t => t.trim()).filter(Boolean)
      : [];

    const cleanedOrderTags = applyCleanRiskTag(existingOrderTags, orderTag);
    if (cleanedOrderTags.join(",") !== existingOrderTags.join(",")) {
      await shopifyRequest("PUT", `orders/${orderId}.json`, {
        order: { id: orderId, tags: cleanedOrderTags.join(", ") },
      });
    }
    console.log(`🚨 [${orderName}] Step 3 OK — tagged as "${orderTag}" (status: ${paymentStatus})`);
  } catch (e) {
    console.error(`✗ [${orderName}] Step 3 FAILED (tag order ${orderId}):`, e.message);
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

// ── Cleanup: fix orders that have BOTH High Risk and Medium Risk tags ──
// (leftover from before tag-replace logic was added)
app.post("/api/cleanup-duplicate-tags", async (req, res) => {
  try {
    const data = await shopifyRequest("GET", `orders.json?status=any&limit=250&fields=id,name,tags`);
    const orders = data.orders || [];

    const fixed = [];
    for (const order of orders) {
      const tags = (order.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const hasHigh = tags.includes("Smart Returns - High Risk Order");
      const hasMedium = tags.includes("Smart Returns - Medium Risk Order");

      if (hasHigh && hasMedium) {
        const cleaned = tags.filter(t => t !== "Smart Returns - Medium Risk Order");
        await shopifyRequest("PUT", `orders/${order.id}.json`, {
          order: { id: order.id, tags: cleaned.join(", ") },
        });
        fixed.push(order.name);
      }
    }

    res.json({ scanned: orders.length, fixed: fixed.length, fixedOrders: fixed });
  } catch (e) {
    console.error("Cleanup error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Force remove Smart Returns tags from specific orders ──
app.post("/api/force-remove-tags", async (req, res) => {
  try {
    const { orderNames } = req.body; // e.g. ["fr-284328", "fr-284329", "fr-284330"]

    // If specific orders provided, remove tags from those only
    // If none provided, re-check ALL tagged orders and remove where now SAFE
    const data = await shopifyRequest("GET",
      `orders.json?status=any&limit=250&fields=id,name,tags,customer_id,created_at,financial_status`
    );
    const allOrders = data.orders || [];

    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(); // 180 days for full history
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fixed = [];

    for (const order of allOrders) {
      const tags = (order.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const hasRiskTag = tags.some(t => t === "Smart Returns - High Risk Order" || t === "Smart Returns - Medium Risk Order");
      if (!hasRiskTag) continue;

      // If orderNames provided, only process those specific orders
      if (orderNames?.length && !orderNames.includes(order.name)) continue;

      if (!order.customer_id) continue;
      await new Promise(r => setTimeout(r, 200));

      try {
        // If this order is already PAID — remove risk tag immediately
        // Paid order = paise aa gaye, risk nahi
        const orderPayStatus = (order.financial_status || "").toLowerCase();
        if (orderPayStatus === "paid") {
          const updatedTags = tags.filter(t =>
            t !== "Smart Returns - High Risk Order" && t !== "Smart Returns - Medium Risk Order"
          );
          await shopifyRequest("PUT", `orders/${order.id}.json`, {
            order: { id: order.id, tags: updatedTags.join(", ") },
          });
          fixed.push({
            order: order.name,
            was: tags.find(t => t.includes("Smart Returns")) || "risk tag",
            now: "✅ Removed — Order Paid",
            mature: 0, bad: 0, delivered: 0,
          });
          console.log(`✅ Removed tag from ${order.name} — already paid`);
          continue;
        }

        const histData = await shopifyRequest("GET",
          `orders.json?customer_id=${order.customer_id}&status=any&created_at_min=${since}&limit=250&fields=id,name,financial_status,cancelled_at,created_at`
        );
        const history = histData.orders || [];

        // Apply 48h rule
        const matureHistory = history.filter(o =>
          String(o.id) !== String(order.id) &&
          new Date(o.created_at) < cutoff24h
        );

        const badOrders = matureHistory.filter(o =>
          o.financial_status === "voided" || o.financial_status === "refunded" || !!o.cancelled_at
        );
        const deliveredOrders = matureHistory.filter(o =>
          o.financial_status === "paid" && !o.cancelled_at
        );

        const { riskLevel } = classifyRisk(matureHistory.length, badOrders.length, deliveredOrders.length);

        // Determine correct tag
        const correctTag = riskLevel === "high-risk" ? "Smart Returns - High Risk Order"
          : riskLevel === "medium-risk" ? "Smart Returns - Medium Risk Order"
          : null;

        // Get current risk tag on this order
        const currentRiskTag = tags.find(t =>
          t === "Smart Returns - High Risk Order" || t === "Smart Returns - Medium Risk Order"
        );

        if (currentRiskTag !== correctTag) {
          const updatedTags = tags.filter(t =>
            t !== "Smart Returns - High Risk Order" && t !== "Smart Returns - Medium Risk Order"
          );
          if (correctTag) updatedTags.push(correctTag);

          await shopifyRequest("PUT", `orders/${order.id}.json`, {
            order: { id: order.id, tags: updatedTags.join(", ") },
          });

          fixed.push({
            order: order.name,
            was: currentRiskTag || "none",
            now: correctTag || "✅ Removed (Safe)",
            mature: matureHistory.length,
            bad: badOrders.length,
            delivered: deliveredOrders.length,
          });
          console.log(`✅ Fixed ${order.name}: ${currentRiskTag} → ${correctTag || "removed"}`);
        }
      } catch(e) {
        console.warn(`Could not fix ${order.name}:`, e.message);
      }
    }

    res.json({ scanned: allOrders.length, fixed: fixed.length, details: fixed });
  } catch (e) {
    console.error("Force remove error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/reevaluate-tags", async (req, res) => {
  try {
    // Fetch all orders that already have a Smart Returns tag
    const [highData, medData] = await Promise.all([
      shopifyRequest("GET", `orders.json?status=any&limit=250&tag=Smart+Returns+-+High+Risk+Order&fields=id,name,tags,customer_id,financial_status`),
      shopifyRequest("GET", `orders.json?status=any&limit=250&tag=Smart+Returns+-+Medium+Risk+Order&fields=id,name,tags,customer_id,financial_status`),
    ]);

    const tagged = [
      ...(highData.orders || []),
      ...(medData.orders || []),
    ];

    // Deduplicate by order ID
    const unique = Object.values(
      Object.fromEntries(tagged.map(o => [o.id, o]))
    );

    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(); // 180 days for full history
    const results = { scanned: unique.length, fixed: 0, fixedOrders: [] };

    for (const order of unique) {
      if (!order.customer_id) continue;
      await new Promise(r => setTimeout(r, 200)); // rate limit protection

      try {
        // Fetch full customer history — include created_at for 48h rule
        const histData = await shopifyRequest("GET",
          `orders.json?customer_id=${order.customer_id}&status=any&created_at_min=${since}&limit=250&fields=id,name,financial_status,cancelled_at,created_at,fulfilled_at`
        );
        const history = histData.orders || [];
        const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Only evaluate mature orders (24h+)
        const matureHistory = history.filter(o =>
          String(o.id) !== String(order.id) &&
          new Date(o.created_at) < cutoff24h
        );

        const badOrders = matureHistory.filter(o =>
          o.financial_status === "voided" || o.financial_status === "refunded" || !!o.cancelled_at
        );
        const deliveredOrders = matureHistory.filter(o =>
          o.financial_status === "paid" && !o.cancelled_at
        );

        console.log(`Re-eval ${order.name}: mature=${matureHistory.length}, bad=${badOrders.length}, delivered=${deliveredOrders.length}`);

        const { riskLevel, deliveryRate } = classifyRisk(matureHistory.length, badOrders.length, deliveredOrders.length);

        const currentTags = (order.tags || "").split(",").map(t => t.trim()).filter(Boolean);
        const hasHigh = currentTags.includes("Smart Returns - High Risk Order");
        const hasMedium = currentTags.includes("Smart Returns - Medium Risk Order");

        let newTag = null;
        if (riskLevel === "high-risk") newTag = "Smart Returns - High Risk Order";
        else if (riskLevel === "medium-risk") newTag = "Smart Returns - Medium Risk Order";

        const currentRiskTag = hasHigh ? "Smart Returns - High Risk Order" : hasMedium ? "Smart Returns - Medium Risk Order" : null;

        if (newTag !== currentRiskTag) {
          // Tag needs updating
          let updatedTags = currentTags.filter(t =>
            t !== "Smart Returns - High Risk Order" && t !== "Smart Returns - Medium Risk Order"
          );
          if (newTag) updatedTags.push(newTag);

          await shopifyRequest("PUT", `orders/${order.id}.json`, {
            order: { id: order.id, tags: updatedTags.join(", ") },
          });

          results.fixed++;
          results.fixedOrders.push({
            order: order.name,
            from: currentRiskTag || "none",
            to: newTag || "removed (now safe)",
            deliveryRate: deliveryRate + "%",
            badOrders: badOrders.length,
            totalOrders,
          });
          console.log(`✅ Re-evaluated ${order.name}: ${currentRiskTag} → ${newTag || "safe"} (${deliveryRate}% delivery)`);
        }
      } catch (e) {
        console.warn(`Could not re-evaluate ${order.name}:`, e.message);
      }
    }

    res.json(results);
  } catch (e) {
    console.error("Re-evaluate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Orders — ALL last 90 days with pagination ──
app.get("/api/orders", async (req, res) => {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const allOrders = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const data = await shopifyGQL(`{
        orders(first: 250${afterClause}, query: "status:any created_at:>='${since}'") {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id name createdAt
            displayFinancialStatus displayFulfillmentStatus
            cancelledAt
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

      const page = data.data.orders;
      const mapped = page.edges.map(({ node: o }) => ({
        id:                 o.id.replace("gid://shopify/Order/", ""),
        name:               o.name,
        created_at:         o.createdAt,
        cancelled_at:       o.cancelledAt || null,
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

      allOrders.push(...mapped);
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;

      // Rate limit protection between pages
      if (hasNextPage) await new Promise(r => setTimeout(r, 300));
    }

    console.log(`Orders: fetched ${allOrders.length} orders from last 90 days`);
    res.json(allOrders);
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
          displayFulfillmentStatus
          createdAt
          cancelledAt
          customer { legacyResourceId }
          refunds { id }
        }}
      }
    }`);

    if (data.errors) throw new Error(data.errors[0].message);

    const orders = data.data.orders.edges.map(e => e.node);
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Group by customer
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
          deliveredCount: 0,
          newOrderCount: 0,
          badOrders: [],
        };
      }

      const status = (order.displayFinancialStatus || "").toLowerCase();
      const fulfillStatus = (order.displayFulfillmentStatus || "").toLowerCase();
      const isCancelled = !!order.cancelledAt;
      const isBad = status === "voided" || isCancelled || status === "refunded" || order.refunds?.length > 0;

      // COD delivered = payment pending BUT fulfillment = fulfilled
      const isCODDelivered = (status === "pending" || status === "payment_pending") && fulfillStatus === "fulfilled";
      const isDelivered = (status === "paid" || isCODDelivered) && !isCancelled;

      const orderAge = new Date(order.createdAt);
      const isMature = orderAge < cutoff24h;

      if (isBad) {
        // Always count bad orders regardless of age
        customerMap[cid].totalOrders++;
        if (status === "voided" || isCancelled) {
          customerMap[cid].voidedCount++;
        } else {
          customerMap[cid].refundedCount++;
        }
        customerMap[cid].badOrders.push(order.name);
      } else if (isDelivered) {
        // Paid or COD fulfilled — count as delivered
        customerMap[cid].totalOrders++;
        customerMap[cid].deliveredCount++;
      } else {
        // Pending/unfulfilled — only count if mature (24h+)
        if (isMature) {
          customerMap[cid].totalOrders++;
        } else {
          customerMap[cid].newOrderCount++;
        }
      }
    }

    // Determine risk level — use bad + delivered as total (skip pending new orders)
    const results = [];
    for (const [cid, c] of Object.entries(customerMap)) {
      c.badOrders = [...new Set(c.badOrders)];
      const badCount = c.badOrders.length;
      if (badCount === 0) continue;

      const effectiveTotal = c.voidedCount + c.refundedCount + c.deliveredCount;
      const { riskLevel, deliveryRate } = classifyRisk(effectiveTotal, badCount, c.deliveredCount);
      if (!riskLevel) continue;

      // Small delay between customers to avoid rate limit
      await new Promise(r => setTimeout(r, 150));

      let tags = [riskLevel];
      if (c.voidedCount > 0) tags.push("voided-order");
      if (c.refundedCount > 0) tags.push("frequent-returns");

      // Get current tags and merge
      try {
        const custData = await shopifyRequest("GET", `customers/${cid}.json`);
        const existing = custData.customer?.tags
          ? custData.customer.tags.split(",").map(t => t.trim()).filter(Boolean)
          : [];

        const merged = applyCleanCustomerRiskTags(existing, tags);

        // Update customer tags
        await shopifyRequest("PUT", `customers/${cid}.json`, {
          customer: {
            id: cid,
            tags: merged.join(", "),
            note: `⚠️ Auto-flagged: ${badCount}/${c.totalOrders} bad orders (${deliveryRate}% delivery rate) in last 90 days. Orders: ${[...new Set(c.badOrders)].join(", ")}`,
          },
        });

        // Also tag all NEW (non-bad, non-paid) orders from this customer
        // Paid orders skip karo — paise aa gaye, risk nahi
        const newOrders = orders.filter(o =>
          o.customer?.legacyResourceId === cid &&
          !c.badOrders.includes(o.name)
        );
        for (const newOrder of newOrders) {
          await new Promise(r => setTimeout(r, 120));
          const orderId = newOrder.id.replace("gid://shopify/Order/", "");

          // Check payment status — skip if paid
          const orderDetail = await shopifyRequest("GET", `orders/${orderId}.json?fields=id,tags,financial_status`);
          const payStatus = (orderDetail.order?.financial_status || "").toLowerCase();

          if (payStatus === "paid") {
            console.log(`Scan: Skipping ${newOrder.name} — already paid`);
            continue; // paid order — skip
          }

          const existingOrderTags = orderDetail.order?.tags
            ? orderDetail.order.tags.split(",").map(t => t.trim()).filter(Boolean)
            : [];
          const riskTag = riskLevel === "high-risk" ? "Smart Returns - High Risk Order" : "Smart Returns - Medium Risk Order";
          const cleanedOrderTags = applyCleanRiskTag(existingOrderTags, riskTag);
          if (cleanedOrderTags.join(",") !== existingOrderTags.join(",")) {
            await shopifyRequest("PUT", `orders/${orderId}.json`, {
              order: { id: orderId, tags: cleanedOrderTags.join(", ") },
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
          deliveryRate,
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
// ── Risk Customers — sirf risky (high + medium), safe nahi ──
app.get("/api/high-risk-customers", async (req, res) => {
  try {
    const [highData, medData] = await Promise.all([
      shopifyRequest("GET", `customers.json?tag=high-risk&limit=250&fields=id,first_name,last_name,email,tags,orders_count,total_spent`),
      shopifyRequest("GET", `customers.json?tag=medium-risk&limit=250&fields=id,first_name,last_name,email,tags,orders_count,total_spent`),
    ]);
    const highRisk = (highData.customers || []).map(c => ({ ...c, _riskLevel: "high-risk" }));
    const medRisk = (medData.customers || []).map(c => ({ ...c, _riskLevel: "medium-risk" }));
    const map = {};
    [...medRisk, ...highRisk].forEach(c => { map[c.id] = c; });
    const all = Object.values(map).sort((a, b) => {
      if (a._riskLevel === "high-risk" && b._riskLevel !== "high-risk") return -1;
      if (b._riskLevel === "high-risk" && a._riskLevel !== "high-risk") return 1;
      return parseFloat(b.total_spent || 0) - parseFloat(a.total_spent || 0);
    });
    res.json(all);
  } catch (e) {
    console.error("Risk customers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Top Customers — Diamond, Gold, Silver (last 90 days paid orders) ──
app.get("/api/top-customers", async (req, res) => {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const data = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since}' financial_status:paid") {
        edges { node {
          id
          totalPriceSet { shopMoney { amount } }
          customer { legacyResourceId }
        }}
      }
    }`);
    if (data.errors) throw new Error(data.errors[0].message);
    const customerSpend = {};
    for (const { node: o } of data.data.orders.edges) {
      const cid = o.customer?.legacyResourceId;
      if (!cid) continue;
      const amount = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
      if (!customerSpend[cid]) customerSpend[cid] = { customerId: cid, totalSpent: 0, orderCount: 0 };
      customerSpend[cid].totalSpent += amount;
      customerSpend[cid].orderCount++;
    }
    const top3 = Object.values(customerSpend).sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 3);
    const result = [];
    for (const c of top3) {
      try {
        const cData = await shopifyRequest("GET", `customers/${c.customerId}.json?fields=id,first_name,last_name,email`);
        const cu = cData?.customer;
        if (!cu) {
          result.push({ customerId: c.customerId, name: `Customer ${c.customerId}`, email: "", totalSpent: c.totalSpent.toFixed(2), orderCount: c.orderCount });
          continue;
        }
        result.push({ customerId: c.customerId, name: `${cu.first_name||""} ${cu.last_name||""}`.trim()||"Unknown", email: cu.email||"", totalSpent: c.totalSpent.toFixed(2), orderCount: c.orderCount });
      } catch(_) {
        result.push({ customerId: c.customerId, name: `Customer ${c.customerId}`, email: "", totalSpent: c.totalSpent.toFixed(2), orderCount: c.orderCount });
      }
    }
    res.json(result);
  } catch (e) {
    console.error("Top customers error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Loyal Customers — 100% safe orders, koi void/cancel nahi ──
app.get("/api/loyal-customers", async (req, res) => {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Fetch all paid orders from last 90 days
    const data = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since}' financial_status:paid") {
        edges { node {
          id name createdAt
          totalPriceSet { shopMoney { amount } }
          customer { legacyResourceId }
          displayFinancialStatus
          cancelledAt
        }}
      }
    }`);

    if (data.errors) throw new Error(data.errors[0].message);

    const paidOrders = data.data.orders.edges.map(e => e.node);

    // Also fetch voided/cancelled orders to exclude those customers
    const badData = await shopifyGQL(`{
      orders(first: 250, query: "created_at:>='${since}'") {
        edges { node {
          id
          displayFinancialStatus
          cancelledAt
          customer { legacyResourceId }
        }}
      }
    }`);

    if (badData.errors) throw new Error(badData.errors[0].message);

    // Find all customer IDs who have ANY bad order
    const badCustomerIds = new Set();
    for (const { node: o } of badData.data.orders.edges) {
      const status = (o.displayFinancialStatus || "").toLowerCase();
      if (status === "voided" || status === "refunded" || !!o.cancelledAt) {
        if (o.customer?.legacyResourceId) {
          badCustomerIds.add(o.customer.legacyResourceId);
        }
      }
    }

    // Group paid orders by customer — exclude anyone with bad history
    const loyalMap = {};
    for (const { node: o } of paidOrders) {
      const cid = o.customer?.legacyResourceId;
      if (!cid || badCustomerIds.has(cid)) continue; // skip risky customers

      const amount = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
      if (!loyalMap[cid]) loyalMap[cid] = { customerId: cid, totalSpent: 0, orderCount: 0 };
      loyalMap[cid].totalSpent += amount;
      loyalMap[cid].orderCount++;
    }

    // Sort by total spent, take top 50
    const topLoyal = Object.values(loyalMap)
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 50);

    // Fetch customer names safely
    const result = [];
    for (const c of topLoyal) {
      await new Promise(r => setTimeout(r, 80));
      try {
        const cData = await shopifyRequest("GET",
          `customers/${c.customerId}.json?fields=id,first_name,last_name,email,phone,total_spent,orders_count`
        );
        const cu = cData?.customer;
        if (!cu) {
          result.push({ customerId: c.customerId, name: `Customer ${c.customerId}`, email: "", phone: "", totalSpent: c.totalSpent.toFixed(2), orderCount: c.orderCount, lifetimeSpent: "0", lifetimeOrders: 0 });
          continue;
        }
        result.push({
          customerId: c.customerId,
          name: `${cu.first_name || ""} ${cu.last_name || ""}`.trim() || "Unknown",
          email: cu.email || "",
          phone: cu.phone || "",
          totalSpent: c.totalSpent.toFixed(2),
          orderCount: c.orderCount,
          lifetimeSpent: cu.total_spent || "0",
          lifetimeOrders: cu.orders_count || 0,
        });
      } catch (_) {
        result.push({ customerId: c.customerId, name: `Customer ${c.customerId}`, email: "", phone: "", totalSpent: c.totalSpent.toFixed(2), orderCount: c.orderCount, lifetimeSpent: "0", lifetimeOrders: 0 });
      }
    }

    res.json(result);
  } catch (e) {
    console.error("Loyal customers error:", e.message);
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
// (Webhook handler above contains the live logic;
//  these were superseded by classifyRisk() + the
//  inline webhook handler at the top of this file.)
// ════════════════════════════════════════════════

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
