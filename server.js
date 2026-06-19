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
          restock_type: "return",
        })),
      },
    });
    res.json(data.refund);
  } catch (e) {
    console.error("Return error:", e.message);
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
