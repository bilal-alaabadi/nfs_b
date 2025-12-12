require("dotenv").config();
const twilio = require("twilio");

// بيانات الدخول من .env
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const client     = twilio(accountSid, authToken);

// أرقام واتساب بصيغة صحيحة
const FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886"; // رقم Twilio Sandbox
const TO   = process.env.TWILIO_TEST_TO; // رقمك أنت بصيغة whatsapp:+968XXXXXXXX

(async () => {
  try {
    // إذا عندك Content Template (قالب موافق عليه من Twilio Business)
    const contentSid = process.env.TWILIO_CONTENT_SID;

    if (contentSid) {
      const contentVariables = JSON.stringify({
        "1": "12/1",   // مثال للمتغيرات داخل القالب
        "2": "3pm"
      });

      const msg = await client.messages.create({
        from: FROM,
        to: TO,
        contentSid,
        contentVariables
      });

      console.log("✅ Sent via Content API:", msg.sid);
      return;
    }

    // الخيار البسيط (يعمل مع Sandbox)
    const msg = await client.messages.create({
      from: FROM,
      to: TO,
      body: "✅ اختبار Twilio WhatsApp — إذا وصلك هذه الرسالة فالاتصال ناجح!"
    });

    console.log("✅ Message sent:", msg.sid);
  } catch (err) {
    console.error("❌ Twilio send error:", err?.message || err);
  }
})();
