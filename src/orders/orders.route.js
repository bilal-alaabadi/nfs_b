// ========================= routes/orders.js (نهائي بعد الإصلاح) =========================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const mongoose = require("mongoose"); // ✅ إضافة لاستعمال ObjectId

const Order = require("./orders.model"); // تأكد من المسار الصحيح عندك
const Product = require("../products/products.model"); //  تفعيل الاستيراد لاستخدامه في زيادة المبيعات
// const verifyToken = require("../middleware/verifyToken");
// const verifyAdmin = require("../middleware/verifyAdmin");

const router = express.Router();

// ===== Helpers عامة =====
function cleanEnvVar(v) {
  if (!v) return "";
  // يشيل أي تعليق داخلي (# ...)، اقتباسات ومسافات زائدة
  return String(v).split("#")[0].replace(/['"]/g, "").trim();
}

function normalizeE164(phone, defaultCC = "968") {
  if (!phone) return null;
  let n = String(phone).trim();

  // شيل كل شيء غير أرقام و+
  n = n.replace(/[^\d+]/g, "");

  // 00XXXXXXXX => +XXXXXXXX
  if (n.startsWith("00")) n = "+" + n.slice(2);

  // لو ما فيه + فاعتبره محلي
  if (!n.startsWith("+")) {
    if (n.startsWith("0")) n = n.slice(1);
    n = `+${defaultCC}${n}`;
  }
  return n;
}

function toWhatsAppAddress(phone, defaultCC = "968") {
  const e164 = normalizeE164(phone, defaultCC);
  if (!e164) return null;
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

// ===== ثواني =====
const THAWANI_API_KEY = process.env.THAWANI_API_KEY; 
const THAWANI_API_URL = process.env.THAWANI_API_URL;
const THAWANI_PUBLISH_KEY = process.env.THAWANI_PUBLISH_KEY;

// لا تنشئ app جديد هنا؛ هذا ملف راوتر فقط
// CORS و JSON تكون في السيرفر الرئيسي

// ========================= Helpers مشتركة للحسابات =========================
const ORDER_CACHE = new Map(); // key: client_reference_id -> value: orderPayload
const toBaisa = (omr) => Math.max(100, Math.round(Number(omr || 0) * 1000)); // >= 100 بيسة

// خصم الأزواج للشيلات (ر.ع.)
const pairDiscountForProduct = (p) => {
  const isShayla = p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
  if (!isShayla) return 0;
  const qty = Number(p.quantity || 0);
  const pairs = Math.floor(qty / 2);
  return pairs * 1; // 1 ر.ع لكل زوج
};

// هل تحتوي بطاقة الهدية على أي قيمة؟
const hasGiftValues = (gc) => {
  if (!gc || typeof gc !== "object") return false;
  const v = (x) => (x ?? "").toString().trim();
  return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
};

// تطبيع بطاقة الهدية إلى شكل ثابت
const normalizeGift = (gc) =>
  hasGiftValues(gc)
    ? { from: gc.from || "", to: gc.to || "", phone: gc.phone || "", note: gc.note || "" }
    : undefined;

// ========================= Twilio WhatsApp (NEW) =========================
const twilio = require("twilio");
const TWILIO_SID = cleanEnvVar(process.env.TWILIO_ACCOUNT_SID);
const TWILIO_TOKEN = cleanEnvVar(process.env.TWILIO_AUTH_TOKEN);
// FROM: يقبل بصيغ متعددة، ننظّفه ونفرض whatsapp:
const RAW_FROM = cleanEnvVar(process.env.TWILIO_WHATSAPP_FROM);
const WA_FROM = RAW_FROM.startsWith("whatsapp:") ? RAW_FROM : `whatsapp:${RAW_FROM}`;

// Admin: ننظفه ونحوله لصيغة واتساب صحيحة
const RAW_ADMIN = cleanEnvVar(process.env.TWILIO_WHATSAPP_TO_ADMIN);
const WA_ADMIN = RAW_ADMIN ? toWhatsAppAddress(RAW_ADMIN, "968") : "";

const twilioClient = (TWILIO_SID && TWILIO_TOKEN) ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

// ========================= create-checkout-session =========================
router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
    depositMode, // إذا true: المقدم 10 ر.ع (من ضمنه التوصيل)
    giftCard,    // { from, to, phone, note } اختياري (على مستوى الطلب)
    gulfCountry,
    shippingMethod
     // الدولة المختارة داخل "دول الخليج" (إن وُجدت)
  } = req.body;

  // رسوم الشحن (ر.ع.)
const shippingFee =
  shippingMethod === "دفع الشحن عند الاستلام"
    ? 0
    : country === "دول الخليج"
      ? (gulfCountry === "الإمارات" ? 4 : 5)
      : (shippingMethod === "المكتب" ? 1 : 2);

  const DEPOSIT_AMOUNT_OMR = 10; // المقدم الثابت

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  try {
    // المجاميع كما في Checkout.jsx
    const productsSubtotal = products.reduce(
      (sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 0),
      0
    );
    const totalPairDiscount = products.reduce((sum, p) => sum + pairDiscountForProduct(p), 0);
    const subtotalAfterDiscount = Math.max(0, productsSubtotal - totalPairDiscount);
    const originalTotal = subtotalAfterDiscount + shippingFee;

    let lineItems = [];
    let amountToCharge = 0;

    if (depositMode) {
      lineItems = [{ name: "دفعة مقدم", quantity: 1, unit_amount: toBaisa(DEPOSIT_AMOUNT_OMR) }];
      amountToCharge = DEPOSIT_AMOUNT_OMR;
    } else {
      lineItems = products.map((p) => {
        const unitBase = Number(p.price || 0);
        const qty = Math.max(1, Number(p.quantity || 1));
        const productDiscount = pairDiscountForProduct(p);
        const unitAfterDiscount = Math.max(0.1, unitBase - productDiscount / qty); // لا يقل عن 0.100
        return { name: String(p.name || "منتج"), quantity: qty, unit_amount: toBaisa(unitAfterDiscount) };
      });

if (shippingFee > 0) {
  lineItems.push({
    name: "رسوم الشحن",
    quantity: 1,
    unit_amount: toBaisa(shippingFee),
  });
}
      amountToCharge = originalTotal;
    }

    const nowId = Date.now().toString();

    // حمولة الطلب الكاملة (سوف نحفظها بعد نجاح الدفع)
    const orderPayload = {
      orderId: nowId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: p.quantity,
        name: p.name,
        price: p.price, // ر.ع.
        image: Array.isArray(p.image) ? p.image[0] : p.image,
        measurements: p.measurements || {},
        category: p.category || "",
        giftCard: normalizeGift(p.giftCard) || undefined,
      })),
      amountToCharge,
      shippingFee,
      customerName,
      customerPhone,
      country,
      wilayat,
      description,
      email: email || "",
      status: "completed",
      depositMode: !!depositMode,
      remainingAmount: depositMode ? Math.max(0, originalTotal - DEPOSIT_AMOUNT_OMR) : 0,
      giftCard: normalizeGift(giftCard),
    };

    // نخزن الطلب مؤقتًا
    ORDER_CACHE.set(nowId, orderPayload);

    const data = {
      client_reference_id: nowId,
      mode: "payment",
      products: lineItems,
      success_url: "https://www.nafascollectionom.com/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "https://www.nafascollectionom.com/cancel",
      metadata: {
        email: String(email || "غير محدد"),
        customer_name: String(customerName || ""),
        customer_phone: String(customerPhone || ""),
        country: String(country || ""),
        wilayat: String(wilayat || ""),
        description: String(description || "لا يوجد وصف"),
        shippingFee: String(shippingFee),
        internal_order_id: String(nowId),
        source: "mern-backend",
      },
    };

    const response = await axios.post(`${THAWANI_API_URL}/checkout/session`, data, {
      headers: { "Content-Type": "application/json", "thawani-api-key": THAWANI_API_KEY },
    });

    const sessionId = response?.data?.data?.session_id;
    if (!sessionId) {
      ORDER_CACHE.delete(nowId);
      return res.status(500).json({ error: "No session_id returned from Thawani", details: response?.data });
    }

    const paymentLink = `https://checkout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISH_KEY}`;
    res.json({ id: sessionId, paymentLink });
  } catch (error) {
    console.error("Error creating checkout session:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to create checkout session",
      details: error?.response?.data || error.message,
    });
  }
});

// ========================= order-with-products (كما كان) =========================
router.get('/order-with-products/:orderId', async (req, res) => {
  try {
      const order = await Order.findById(req.params.orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // لو بتستخدم Product فعّل الاستيراد بالأعلى
      // const products = await Promise.all(order.products.map(async item => {
      //     const product = await Product.findById(item.productId);
      //     return {
      //         ...product.toObject(),
      //         quantity: item.quantity,
      //         selectedSize: item.selectedSize,
      //         price: calculateProductPrice(product, item.quantity, item.selectedSize)
      //     };
      // }));

      // res.json({ order, products });
      res.json({ order, products: order.products || [] });
  } catch (err) {
      res.status(500).json({ error: err.message });
  }
});

function calculateProductPrice(product, quantity, selectedSize) {
  if (product.category === 'حناء بودر' && selectedSize && product.price[selectedSize]) {
      return (product.price[selectedSize] * quantity).toFixed(2);
  }
  return (product.regularPrice * quantity).toFixed(2);
}

// ========================= confirm-payment (مع إرسال واتساب) =========================
// ========================= confirm-payment (مع إرسال واتساب + منع التكرار) =========================
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  // Helpers محليّة للتطبيع (نسخة محلية)
  const _hasGiftValues = (gc) => {
    if (!gc || typeof gc !== "object") return false;
    const v = (x) => (x ?? "").toString().trim();
    return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
  };
  const _normalizeGift = (gc) =>
    _hasGiftValues(gc)
      ? { from: gc.from || "", to: gc.to || "", phone: gc.phone || "", note: gc.note || "" }
      : undefined;

  try {
    // 1) جلب قائمة الجلسات ثم إيجاد الجلسة بالـ client_reference_id
    const sessionsResponse = await axios.get(
      `${THAWANI_API_URL}/checkout/session/?limit=20&skip=0`,
      { headers: { "Content-Type": "application/json", "thawani-api-key": THAWANI_API_KEY } }
    );

    const sessions = sessionsResponse?.data?.data || [];
    const sessionSummary = sessions.find((s) => s.client_reference_id === client_reference_id);

    if (!sessionSummary) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session_id = sessionSummary.session_id;

    // 2) تفاصيل الجلسة
    const response = await axios.get(
      `${THAWANI_API_URL}/checkout/session/${session_id}?limit=1&skip=0`,
      { headers: { "Content-Type": "application/json", "thawani-api-key": THAWANI_API_KEY } }
    );

    const session = response?.data?.data;
    if (!session || session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not successful or session not found" });
    }

    // 3) ميتاداتا
    const meta = session?.metadata || session?.meta_data || {};
    const metaCustomerName = meta.customer_name || "";
    const metaCustomerPhone = meta.customer_phone || "";
    const metaEmail = meta.email || "";
    const metaCountry = meta.country || "";
    const metaWilayat = meta.wilayat || "";
    const metaDescription = meta.description || "";
    const metaShippingFee =
      typeof meta.shippingFee !== "undefined" ? Number(meta.shippingFee) : undefined;

    // 4) احتمال وجود طلب سابق
    let order = await Order.findOne({ orderId: client_reference_id });

    // المبلغ المدفوع فعليًا (من ثواني) بالريال
    const paidAmountOMR = Number(session.total_amount || 0) / 1000;

    // نجلب الكاش
    const cached = ORDER_CACHE.get(client_reference_id) || {};

    // منتجات من الكاش
    const productsFromCache = Array.isArray(cached.products)
      ? cached.products.map((p) => {
          const giftCard = _normalizeGift(p.giftCard);
          return {
            productId: p.productId || p._id,
            quantity: p.quantity,
            name: p.name,
            price: p.price, // ر.ع.
            image: Array.isArray(p.image) ? p.image[0] : p.image,
            category: p.category || "",
            measurements: p.measurements || {},
            giftCard,
          };
        })
      : [];

    // fallback ذكي لرسوم الشحن
    const resolvedShippingFee = (() => {
      if (typeof metaShippingFee !== "undefined") return metaShippingFee;
      if (typeof cached.shippingFee !== "undefined") return Number(cached.shippingFee);
      const country = (cached.country || metaCountry || "").trim();
      const gulfCountryFromMeta = (meta.gulfCountry || meta.gulf_country || "").trim();
      if (country === "دول الخليج") {
        return gulfCountryFromMeta === "الإمارات" ? 4 : 5;
      }
      if (cached.shippingMethod === "المكتب") return 1;
      return 2;
    })();

    // 5) أنشئ/حدّث الطلب + تتبع إن كان جديدًا أو لم يكن Completed
    let isNewOrder = false;
    let wasAlreadyCompleted = false;

    if (!order) {
      isNewOrder = true;
      const orderLevelGift = _normalizeGift(cached.giftCard);
      order = new Order({
        orderId: cached.orderId || client_reference_id,
        products: productsFromCache,
        amount: paidAmountOMR,
        shippingFee: resolvedShippingFee,
        customerName: cached.customerName || metaCustomerName,
        customerPhone: cached.customerPhone || metaCustomerPhone,
        country: cached.country || metaCountry,
        wilayat: cached.wilayat || metaWilayat,
        description: cached.description || metaDescription,
        email: cached.email || metaEmail,
        status: "completed",
        depositMode: !!cached.depositMode,
        remainingAmount: Number(cached.remainingAmount || 0),
        giftCard: orderLevelGift,
      });
    } else {
      wasAlreadyCompleted = order.status === "completed"; // ✅ مهم لمنع التكرار
      order.status = "completed";
      order.amount = paidAmountOMR;

      if (!order.customerName && metaCustomerName) order.customerName = metaCustomerName;
      if (!order.customerPhone && metaCustomerPhone) order.customerPhone = metaCustomerPhone;
      if (!order.country && metaCountry) order.country = metaCountry;
      if (!order.wilayat && metaWilayat) order.wilayat = metaWilayat;
      if (!order.description && metaDescription) order.description = metaDescription;
      if (!order.email && metaEmail) order.email = metaEmail;

      if (order.shippingFee === undefined || order.shippingFee === null) {
        order.shippingFee = resolvedShippingFee;
      }

      if (productsFromCache.length > 0) {
        order.products = productsFromCache;
      }

      if (!hasGiftValues(order.giftCard) && hasGiftValues(cached.giftCard)) {
        order.giftCard = _normalizeGift(cached.giftCard);
      }
    }

    // تخزين session_id ووقت الدفع
    order.paymentSessionId = session_id;
    order.paidAt = new Date();

    await order.save();

    // ✅ زيادة عدد المبيعات مرة واحدة فقط:
    //    - إذا كان الطلب جديدًا، أو
    //    - إذا لم يكن سابقًا بحالة completed (أصبح الآن completed لأول مرّة)
    if (isNewOrder || !wasAlreadyCompleted) {
      try {
        const items = Array.isArray(order.products) ? order.products : productsFromCache;
        await Promise.all(
          items.map((it) => {
            let pid = null;
            try {
              pid = new mongoose.Types.ObjectId(String(it.productId));
            } catch {
              return Promise.resolve();
            }
            const incBy = Number(it.quantity) || 1;
            return Product.updateOne({ _id: pid }, { $inc: { salesCount: incBy } }).exec();
          })
        );
      } catch (incErr) {
        console.error("Error incrementing product salesCount:", incErr);
      }
    }

    // ========================= Twilio WhatsApp Notifications (إصلاح قناة from/to) =========================
    if (twilioClient) {
      const FROM = WA_FROM.startsWith("whatsapp:") ? WA_FROM : `whatsapp:${WA_FROM}`;
      const adminWA = WA_ADMIN ? (WA_ADMIN.startsWith("whatsapp:") ? WA_ADMIN : `whatsapp:${WA_ADMIN}`) : "";

      const customerPhoneRaw = order.customerPhone || metaCustomerPhone || "";
      const customerWA = toWhatsAppAddress(customerPhoneRaw, "968");

      console.log("[TWILIO] FROM:", FROM);
      console.log("[TWILIO] ADMIN:", adminWA);
      console.log("[TWILIO] CUSTOMER:", customerWA);

      const orderCurrency = (order.currency || "OMR") === "AED" ? "د.إ" : "ر.ع.";
      const customerName = order.customerName || metaCustomerName || "عميل";

      if (adminWA) {
        const adminMsg =
`✅ تم استلام طلب جديد
👤 العميل: ${customerName}
📞 الهاتف: ${customerPhoneRaw}
🌍 البلد: ${order.country || metaCountry || "-"}
💰 المبلغ: ${order.amount} ${orderCurrency}
🧾 رقم الطلب: ${order.orderId}
⏱️ الوقت: ${new Date(order.paidAt).toLocaleString("ar-OM")}
`;
        try {
          await twilioClient.messages.create({ from: FROM, to: adminWA, body: adminMsg });
        } catch (e) {
          console.error("Twilio (admin) error:", e?.message || e);
        }
      }

      if (customerWA) {
        const customerMsg =
`مرحبًا ${customerName} 🌸
شكرًا لتسوقك من Nafas Collection!
تم استلام طلبك رقم ${order.orderId} بنجاح.
المبلغ المدفوع: ${order.amount} ${orderCurrency}
سنقوم بالتواصل معك لتحديثات الشحن قريبًا.`;
        try {
          await twilioClient.messages.create({ from: FROM, to: customerWA, body: customerMsg });
        } catch (e) {
          console.error("Twilio (customer) error:", e?.message || e);
        }
      }
    } else {
      console.warn("Twilio disabled: missing SID/TOKEN environment variables.");
    }
    // ========================= END Twilio =========================

    ORDER_CACHE.delete(client_reference_id);

    res.json({ order });
  } catch (error) {
    console.error("Error confirming payment:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to confirm payment",
      details: error?.response?.data || error.message,
    });
  }
});



// ========================= REST of order routes (كما هي لديك) =========================

// Get order by email
router.get("/:email", async (req, res) => {
  const email = req.params.email;

  if (!email) return res.status(400).send({ message: "Email is required" });

  try {
    const orders = await Order.find({ email });
    if (orders.length === 0) return res.status(404).send({ message: "No orders found for this email" });
    res.status(200).send({ orders });
  } catch (error) {
    console.error("Error fetching orders by email:", error);
    res.status(500).send({ message: "Failed to fetch orders by email" });
  }
});

// get order by id
router.get("/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).send({ message: "Order not found" });
    res.status(200).send(order);
  } catch (error) {
    console.error("Error fetching orders by user id", error);
    res.status(500).send({ message: "Failed to fetch orders by user id" });
  }
});

// get all orders
router.get("/", async (req, res) => {
  try {
    const orders = await Order.find({ status: "completed" }).sort({ createdAt: -1 });
    if (orders.length === 0) return res.status(404).send({ message: "No orders found", orders: [] });
    res.status(200).send(orders);
  } catch (error) {
    console.error("Error fetching all orders", error);
    res.status(500).send({ message: "Failed to fetch all orders" });
  }
});

// update order status
router.patch("/update-order-status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).send({ message: "Status is required" });

  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { status, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!updatedOrder) return res.status(404).send({ message: "Order not found" });

    res.status(200).json({ message: "Order status updated successfully", order: updatedOrder });
  } catch (error) {
    console.error("Error updating order status", error);
    res.status(500).send({ message: "Failed to update order status" });
  }
});

// delete order
router.delete('/delete-order/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deletedOrder = await Order.findByIdAndDelete(id);
    if (!deletedOrder) return res.status(404).send({ message: "Order not found" });
    res.status(200).json({ message: "Order deleted successfully", order: deletedOrder });
  } catch (error) {
    console.error("Error deleting order", error);
    res.status(500).send({ message: "Failed to delete order" });
  }
});

module.exports = router;
