# Arena Mining (فرانت + بک‌اند)

```
arena-mining/
  backend/    API + worker + bot (Node.js, TypeScript, PostgreSQL)  → راهنمای کامل: backend/README.md
  frontend/
    index.html   مینی‌اپ تلگرام، وصل به API (همین را منتشر کن)
    demo.html    نسخه‌ی نمایشی بدون سرور (برای دیدن ظاهر)
```

## راه‌اندازی رایگان، قدم‌به‌قدم

1. **ربات:** در BotFather با `/newbot` بساز و توکن را نگه دار. ربات را **ادمین چنل** خودت کن.
2. **دیتابیس:** در neon.tech پروژه بساز و connection string نوع **direct** را کپی کن.
3. **بک‌اند:** پوشه‌ی `backend` را در یک ریپوی خصوصی GitHub بگذار، در render.com گزینه‌ی New > Blueprint را بزن (فایل `render.yaml` آماده است) و متغیرها را از `backend/.env.example` پر کن (حتماً `SUPPORT_CHANNEL`). اول `TON_NETWORK=testnet` بماند.
4. آدرس سرویس Render (مثل `https://arena-mining.onrender.com`) را در UptimeRobot هر ۵ دقیقه روی `/health` ping کن تا نخوابد.
5. **فرانت:** در `frontend/index.html` اولین خط اسکریپت را عوض کن: `const API_URL = 'https://arena-mining.onrender.com';` و فایل را در Cloudflare Pages (یا هر هاست استاتیک) منتشر کن. در `CORS_ORIGIN` بک‌اند هم آدرس Pages را بگذار.
6. در BotFather: `/newapp` (یا Menu Button) و آدرس Pages را به ربات وصل کن.
7. با چند اکانت تلگرام روی **testnet** تست کن: ورود، خرید، مارکت، تسک، واریز و برداشت. بعد از اطمینان، `.env` را روی mainnet ببر.

## تسک‌ها

- چنل اصلی خودت: در `.env` بنویس `SUPPORT_CHANNEL=@چنل_تو` و ربات را ادمین آن کن. بالای لیست همه نمایش داده می‌شود و هر کاربر فقط یک‌بار می‌تواند بگیرد.
- کاربران هم از تب Tasks می‌توانند چنل خودشان را تبلیغ کنند (بودجه ۱۰۰ تا ۱۰۰۰ MINE، ۵۰ MINE به ازای هر عضو جدید). جزئیات و تنظیمات در `backend/README.md`.
- پیش‌فرض هر تبلیغ جدید قبل از نمایش باید توسط تو تأیید شود (`POST /admin/tasks/:id/approve` با هدر `x-admin-token`).

## کارمزدها

- مارکت بازیکن‌ها: **۱٪** از فروشنده (`MARKET_FEE_BPS=100`؛ طبق تنظیم درصدی از کارمزد سوزانده می‌شود و باقی خزانه).
- برداشت: **۷۰ MINE** ثابت برای هر برداشت (`WITHDRAW_FEE=70`)، علاوه بر مبلغی که کاربر دریافت می‌کند. اگر کاربر ۲۰۰ بخواهد، ۲۷۰ از موجودی‌اش کم می‌شود.
- هر دو را بدون تغییر کد از `.env` عوض کن. فرانت مقدارها را از API می‌خواند.

## قبل از پول واقعی

- اعداد اقتصاد در `backend/src/economy.ts` فرضی‌اند؛ شبیه‌سازی کن.
- mnemonic فقط روی سرور worker، `/admin` را عمومی نگذار، موجودی ولت گرم را کم نگه دار.
- این کد روی دیتابیس و بلاکچین واقعی اجرا نشده؛ تست testnet الزامی است.
