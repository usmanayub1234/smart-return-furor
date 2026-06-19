import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion, Session } from "@shopify/shopify-api";
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || "dummy",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "dummy",
  scopes: ["read_orders", "write_orders", "read_products"],
  hostName: process.env.HOST?.replace(/^https?:\/\//, "") || "localhost",
  hostScheme: "https",
  apiVersion: ApiVersion.April25,
  isEmbeddedApp: false,
});

// Build a session object for the custom app token
function getSession() {
  const session = new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "active",
    isOnline: false,
  });
  session.accessToken = TOKEN;
  return session;
}

const app = express();
app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

// ── Serve embedded app ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── API: Orders ──
app.get("/api/orders", async (req, res) => {
  try {
    const session = getSession();
    const client = new shopify.clients.Graphql({ session });
    const response = await client.request(`
      {
        orders(first: 50, query: "status:any") {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount } }
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    title
                    variantTitle
                    quantity
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                }
              }
            }
          }
        }
      }
    `);
    const orders = response.data.orders.edges.map(({ node }) => ({
      id: node.id.replace("gid://shopify/Order/", ""),
      name: node.name,
      created_at: node.createdAt,
      financial_status: node.displayFinancialStatus?.toLowerCase().replace(/_/g, " "),
      fulfillment_status: node.displayFulfillmentStatus?.toLowerCase().replace(/_/g, " "),
      total_price: node.totalPriceSet?.shopMoney?.amount || "0",
      line_items: node.lineItems.edges.map(({ node: li }) => ({
        id: li.id.replace("gid://shopify/LineItem/", ""),
        title: li.title,
        variant_title: li.variantTitle,
        quantity: li.quantity,
        price: li.originalUnitPriceSet?.shopMoney?.amount || "0",
      })),
    }));
    res.json(orders);
  } catch (e) {
    console.error("Orders error:", e.message, e.response?.errors);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Returns ──
app.post("/api/returns", async (req, res) => {
  const { orderId, lineItems, reason, notifyCustomer } = req.body;
  try {
    const session = getSession();
    const client = new shopify.clients.Rest({ session });
    const response = await client.post({
      path: `orders/${orderId}/refunds`,
      data: {
        refund: {
          notify: notifyCustomer ?? true,
          note: reason || "Customer return",
          refund_line_items: (lineItems || []).map(li => ({
            line_item_id: li.id,
            quantity: li.quantity,
            restock_type: "return",
          })),
        },
      },
    });
    res.json(response.body.refund);
  } catch (e) {
    console.error("Return error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Analytics ──
app.get("/api/analytics", async (req, res) => {
  try {
    const session = getSession();
    const client = new shopify.clients.Graphql({ session });
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const response = await client.request(`
      {
        orders(first: 250, query: "created_at:>='${since}'") {
          edges {
            node {
              id
              refunds {
                note
                refundLineItems(first: 10) {
                  edges {
                    node {
                      quantity
                      subtotalSet { shopMoney { amount } }
                      lineItem { title }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);
    const orders = response.data.orders.edges.map(e => e.node);
    let totalRefunds = 0, refundAmount = 0;
    const reasonMap = {}, productMap = {};
    for (const order of orders) {
      if (order.refunds?.length) {
        totalRefunds++;
        for (const ref of order.refunds) {
          const note = ref.note || "No reason given";
          reasonMap[note] = (reasonMap[note] || 0) + 1;
          for (const rli of ref.refundLineItems?.edges || []) {
            const title = rli.node.lineItem?.title || "Unknown";
            productMap[title] = (productMap[title] || 0) + rli.node.quantity;
            refundAmount += parseFloat(rli.node.subtotalSet?.shopMoney?.amount || 0);
          }
        }
      }
    }
    res.json({
      totalOrders: orders.length,
      totalRefunds,
      returnRate: orders.length ? ((totalRefunds / orders.length) * 100).toFixed(1) : 0,
      refundAmount: refundAmount.toFixed(2),
      topProducts: Object.entries(productMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,qty])=>({name,qty})),
      topReasons: Object.entries(reasonMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([reason,count])=>({reason,count})),
    });
  } catch (e) {
    console.error("Analytics error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Health ──
app.get("/health", (_, res) => res.json({ status: "ok", shop: SHOP, hasToken: !!TOKEN }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Return Furor on port ${PORT} → ${SHOP}`));
