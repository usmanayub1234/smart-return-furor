import "@shopify/shopify-api/adapters/node";
import express from "express";
import { shopifyApi, ApiVersion, LogSeverity } from "@shopify/shopify-api";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory session store
const sessionStorage = new Map();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ["read_orders", "write_orders", "read_products"],
  hostName: process.env.HOST.replace(/^https?:\/\//, ""),
  hostScheme: "https",
  apiVersion: ApiVersion.January25,
  isEmbeddedApp: true,
  logger: { level: LogSeverity.Debug },
  sessionStorage: {
    storeSession: async (session) => { sessionStorage.set(session.id, session); return true; },
    loadSession: async (id) => sessionStorage.get(id) || undefined,
    deleteSession: async (id) => { sessionStorage.delete(id); return true; },
  },
});

const app = express();
app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

// ── Manual OAuth: Begin ──
app.get("/auth", async (req, res) => {
  try {
    const shop = shopify.utils.sanitizeShop(req.query.shop, true);
    if (!shop) return res.status(400).send("Missing shop parameter");

    await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    console.error("Auth begin error:", e);
    res.status(500).send("Auth error: " + e.message);
  }
});

// ── Manual OAuth: Callback ──
app.get("/auth/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    await shopify.config.sessionStorage.storeSession(session);
    console.log("OAuth success for shop:", session.shop);

    // Redirect to app root embedded in Shopify
    const host = req.query.host;
    res.redirect(`/?shop=${session.shop}&host=${host}`);
  } catch (e) {
    console.error("Auth callback error:", e);
    res.status(500).send("OAuth callback error: " + e.message);
  }
});

// ── Session check middleware ──
async function requireSession(req, res, next) {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop");
  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.redirect(`/auth?shop=${shop}`);
  req.shopifySession = session;
  next();
}

// ── App root ──
app.get("/", requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── API: Orders (GraphQL — no protected customer data) ──
app.get("/api/orders", async (req, res) => {
  const shop = req.query.shop;
  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  try {
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
      financial_status: node.displayFinancialStatus?.toLowerCase(),
      fulfillment_status: node.displayFulfillmentStatus?.toLowerCase(),
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
    console.error("Orders GraphQL error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Returns ──
app.post("/api/returns", async (req, res) => {
  const { shop, orderId, lineItems, reason, notifyCustomer } = req.body;
  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  try {
    const client = new shopify.clients.Rest({ session });
    const response = await client.post({
      path: `orders/${orderId}/refunds`,
      data: {
        refund: {
          notify: notifyCustomer ?? true,
          note: reason || "Customer return",
          refund_line_items: (lineItems || []).map(li => ({
            line_item_id: li.id, quantity: li.quantity, restock_type: "return"
          })),
        }
      },
    });
    res.json(response.body.refund);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Analytics (GraphQL) ──
app.get("/api/analytics", async (req, res) => {
  const shop = req.query.shop;
  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  try {
    const client = new shopify.clients.Graphql({ session });
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const response = await client.request(`
      {
        orders(first: 250, query: "created_at:>='${since}'") {
          edges {
            node {
              id
              displayFinancialStatus
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
    console.error("Analytics error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Health ──
app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Return Furor on port ${PORT}`));
