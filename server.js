import "@shopify/shopify-api/adapters/node";
import express from "express";
import { shopifyApi, ApiVersion, Session } from "@shopify/shopify-api";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- In-memory session storage (swap for DB in production) ---
const sessionStorage = new Map();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ["read_orders", "write_orders", "read_products"],
  hostName: process.env.HOST.replace(/^https?:\/\//, ""),
  hostScheme: "https",
  apiVersion: ApiVersion.January25,
  isEmbeddedApp: true,
  sessionStorage: {
    storeSession: async (session) => {
      sessionStorage.set(session.id, session);
      return true;
    },
    loadSession: async (id) => sessionStorage.get(id) || undefined,
    deleteSession: async (id) => {
      sessionStorage.delete(id);
      return true;
    },
  },
});

const app = express();
app.use(express.json());

// Serve static frontend files
app.use("/static", express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------
// OAuth: Begin install
// ----------------------------------------------------------------
app.get("/auth", async (req, res) => {
  await shopify.auth.begin({
    shop: shopify.utils.sanitizeShop(req.query.shop, true),
    callbackPath: "/auth/callback",
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
});

// ----------------------------------------------------------------
// OAuth: Callback
// ----------------------------------------------------------------
app.get("/auth/callback", async (req, res) => {
  try {
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    const { session } = callbackResponse;
    await shopify.config.sessionStorage.storeSession(session);

    // Redirect into the embedded app
    const host = req.query.host;
    res.redirect(`/?shop=${session.shop}&host=${host}`);
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.status(500).send("OAuth error: " + e.message);
  }
});

// ----------------------------------------------------------------
// Middleware: verify embedded session
// ----------------------------------------------------------------
async function ensureInstalled(req, res, next) {
  const shop = req.query.shop;
  if (!shop) return res.redirect("/auth?shop=" + shop);

  // Try to find an offline session
  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.redirect(`/auth?shop=${shop}`);

  req.shopifySession = session;
  next();
}

// ----------------------------------------------------------------
// App root – serve the embedded SPA
// ----------------------------------------------------------------
app.get("/", ensureInstalled, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================================================================
// API Routes
// ================================================================

// GET /api/orders?shop=xxx  – fetch recent orders for return analysis
app.get("/api/orders", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "shop required" });

  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });

  try {
    const client = new shopify.clients.Rest({ session });
    const response = await client.get({
      path: "orders",
      query: { status: "any", limit: 50, fields: "id,name,email,created_at,financial_status,fulfillment_status,line_items,total_price,tags" },
    });
    res.json(response.body.orders || []);
  } catch (e) {
    console.error("Orders fetch error:", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/returns  – create a return / refund
app.post("/api/returns", async (req, res) => {
  const { shop, orderId, lineItems, reason, notifyCustomer } = req.body;
  if (!shop || !orderId) return res.status(400).json({ error: "shop and orderId required" });

  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });

  try {
    const client = new shopify.clients.Rest({ session });

    // Build refund line items
    const refundLineItems = (lineItems || []).map((li) => ({
      line_item_id: li.id,
      quantity: li.quantity,
      restock_type: "return",
    }));

    const body = {
      refund: {
        notify: notifyCustomer ?? true,
        note: reason || "Customer return request",
        shipping: { full_refund: false },
        refund_line_items: refundLineItems,
      },
    };

    const response = await client.post({
      path: `orders/${orderId}/refunds`,
      data: body,
    });
    res.json(response.body.refund);
  } catch (e) {
    console.error("Return creation error:", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics?shop=xxx  – return analytics summary
app.get("/api/analytics", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "shop required" });

  const sessionId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) return res.status(401).json({ error: "Not authenticated" });

  try {
    const client = new shopify.clients.Rest({ session });
    // Fetch refunds from last 90 days
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const ordersResp = await client.get({
      path: "orders",
      query: { status: "any", limit: 250, created_at_min: since, fields: "id,name,refunds,total_price,financial_status,line_items" },
    });
    const orders = ordersResp.body.orders || [];

    let totalOrders = orders.length;
    let totalRefunds = 0;
    let refundAmount = 0;
    const reasonMap = {};
    const productMap = {};

    for (const order of orders) {
      if (order.refunds && order.refunds.length > 0) {
        totalRefunds++;
        for (const ref of order.refunds) {
          // note as reason bucket
          const note = ref.note || "No reason given";
          reasonMap[note] = (reasonMap[note] || 0) + 1;
          for (const rli of ref.refund_line_items || []) {
            const title = rli.line_item?.title || "Unknown";
            productMap[title] = (productMap[title] || 0) + rli.quantity;
            refundAmount += parseFloat(rli.subtotal || 0);
          }
        }
      }
    }

    const topProducts = Object.entries(productMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    const topReasons = Object.entries(reasonMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    res.json({
      totalOrders,
      totalRefunds,
      returnRate: totalOrders ? ((totalRefunds / totalOrders) * 100).toFixed(1) : 0,
      refundAmount: refundAmount.toFixed(2),
      topProducts,
      topReasons,
    });
  } catch (e) {
    console.error("Analytics error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Return Furor listening on port ${PORT}`));
