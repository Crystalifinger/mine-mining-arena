# Arena Mining Backend

Node.js 20+ / TypeScript / Fastify / PostgreSQL. سه پروسه‌ی جدا:

| پروسه | وظیفه | دستور |
|---|---|---|
| **api** | API برای مینی‌اپ و پنل ادمین | `npm start` |
| **worker** | ساخت بلاک هر ۱۰ دقیقه، شناسایی واریز TON/MINE، ارسال برداشت‌ها (فقط یک نمونه اجرا شود) | `npm run worker` |
| **bot** | ربات تلگرام (`/start` مینی‌اپ را باز می‌کند) | `npm run bot` |

## راه‌اندازی

```bash
cp .env.example .env        # مقادیر را پر کن (پایین‌تر توضیح داده شده)
docker compose up -d --build   # postgres + migrate/seed + api + worker + bot
# یا بدون docker:
npm install && npm run build && npm run migrate && npm run seed
npm start & npm run worker & npm run bot
```

**قبل از پول واقعی حتماً روی testnet تست کن** (`TON_NETWORK=testnet` و `HOT_WALLET_VERSION=v4`).

## اطلاعاتی که باید در `.env` بگذاری

- `BOT_TOKEN` از BotFather، `WEBAPP_URL` آدرس مینی‌اپ (HTTPS)
- `HOT_WALLET_ADDRESS` آدرس **عمومی** ولت واریز/برداشت
- `MINE_JETTON_MASTER` آدرس master قرارداد توکن، و `MINE_DECIMALS`
- `HOT_WALLET_MNEMONIC` فقط روی سرور worker. **هرگز در چت، گیت یا فرانت قرار نگیرد.** (worker بدون آن فقط واریزها را شناسایی می‌کند و برداشتی نمی‌فرستد.)
- `TONCENTER_API_KEY` از toncenter.com (بدون کلید فقط ۱ درخواست در ثانیه)
- `MINING_POOL_TOTAL` مقدار MINE که برای پاداش ماینینگ کنار گذاشتی. **این مقدار باید واقعاً داخل ولت گرم باشد**
- `JWT_SECRET`, `ADMIN_TOKEN` رشته‌های تصادفی بلند

## جریان واریز

کاربر به `HOT_WALLET_ADDRESS` واریز می‌کند و `memo` اختصاصی‌اش (از `GET /wallet`) را در **comment** می‌گذارد.
worker هر ۱۰ ثانیه TON (از `/api/v3/messages`) و MINE (از `/api/v3/jetton/transfers`) را می‌خواند، پس از ۲۰ ثانیه (`DEPOSIT_CONFIRM_SECONDS`) به کاربر اعتبار می‌دهد. هر تراکنش فقط یک‌بار اعتبار می‌گیرد (unique روی `chain_ref`). واریز بدون memo یا با memo اشتباه در جدول `deposits` با وضعیت `unmatched` می‌ماند و ادمین با `POST /admin/deposits/:id/assign` دستی اعتبار می‌دهد.

## جریان برداشت (ترکیبی)

1. کاربر `POST /withdraw {amount, address}` می‌زند. چک‌ها: حداقل مبلغ، سن اکانت (`WITHDRAW_MIN_ACCOUNT_AGE_HOURS`)، سقف روزانه‌ی **رنک** (UTC)، آدرس معتبر.
2. مبلغ همان لحظه به حساب `withdraw_hold` منتقل (قفل) می‌شود.
3. اگر `amount <= WITHDRAW_AUTO_LIMIT` و سقف کل روزانه‌ی پروژه (`WITHDRAW_GLOBAL_DAILY_CAP`) پر نشده، وضعیت `approved` و worker خودکار می‌فرستد؛ وگرنه `pending_review` و ادمین (و پیام به `ADMIN_CHAT_ID`) باید تأیید کند.
4. worker پیش از ارسال وضعیت را `sending` می‌کند و **هرگز خودکار دوباره نمی‌فرستد**. `query_id` تراکنش = شناسه‌ی برداشت، پس reconcile آن را روی بلاکچین پیدا و `confirmed` می‌کند.
5. اگر ۱۵ دقیقه روی زنجیره دیده نشد: `needs_review`. ادمین با `recheck` می‌گردد، بعد یکی از `mark-confirmed`، `refund` یا (فقط اگر مطمئن است چیزی ارسال نشده) `requeue`.

رنک و سقف برداشت از **توان هش آخرین بلاک** حساب می‌شود، نه رک لحظه‌ای، تا کسی لحظه‌ای ماینر نگذارد و سقف بالا بگیرد.

## ماینینگ و سختی شبکه

هر ۱۰ دقیقه یک بلاک (`height = floor(unix / BLOCK_SECONDS)`، idempotent). هر رنک شبکه‌ی جدا دارد: پاداش ثابت رنک بین ماینرهای همان رنک به نسبت هش تقسیم می‌شود. مخرج حداقل `FLOOR_HASH` است تا شبکه‌ی خالی کل پاداش را نبلعد. هاوینگ هر `HALVING_BLOCKS` بلاک. پاداش‌ها در `block_rewards` جمع می‌شوند و با `POST /claim` به موجودی می‌روند. پاداش هرگز بیشتر از موجودی حساب `emission` نیست.

اعداد رنک‌ها (`src/economy.ts`) **فرضی‌اند**. قبل از لانچ با شبیه‌سازی تنظیم کن.

## حسابداری (دفتر کل)

همه‌ی تغییر موجودی‌ها انتقال بین دو حساب در جدول `ledger` است (دوطرفه)، با CHECK برای منفی نشدن موجودی کاربر. `GET /admin/solvency` بدهی داخلی (موجودی کاربران + پاداش‌های ادعا‌نشده + برداشت‌های قفل‌شده) را با MINE واقعی ولت گرم مقایسه می‌کند. این را هر روز نگاه کن.

## API (همه با `Authorization: Bearer <token>`)

| | |
|---|---|
| `POST /auth/telegram {initData}` | ورود؛ توکن JWT و `isNew` (کاربر جدید ماینر رایگان Spark می‌گیرد) |
| `GET /me`, `/state`, `/network` | پروفایل، رک و موجودی، سختی شبکه |
| `POST /rack/place {minerId, slot}`, `/rack/remove {minerId}` | چیدن ماینر |
| `POST /claim` | برداشت پاداش بلاک‌ها به موجودی |
| `GET /store`, `POST /store/buy {typeId, currency}` | استور (TON یا MINE) |
| `GET /market?sort=price\|hash\|value`, `POST /market/list {minerId, price}`, `/market/cancel`, `/market/buy` | مارکت P2P (فقط MINE، کارمزد پیش‌فرض ۱٪ از فروشنده، تنظیم‌پذیر با `MARKET_FEE_BPS=100`) |
| `GET /wallet`, `GET /wallet/history` | آدرس و memo واریز، سقف‌ها، تاریخچه |
| `POST /withdraw {amount, address}`, `GET /withdrawals` | برداشت |
| `/admin/*` با هدر `x-admin-token` | `stats`, `solvency`, `withdrawals`, `deposits`, `users/:id/ban`, `miner-types/:id` |

مبلغ‌ها همیشه **رشته‌ی دسیمال** هستند (مثلاً `"12.5"`).

## امنیت (حتماً)

- پنل `/admin` را روی اینترنت عمومی باز نگذار (IP allowlist یا VPN در reverse proxy).
- موجودی ولت گرم را کم نگه دار؛ مازاد را دستی به ولت سرد ببر. mnemonic فقط روی سرور worker.
- HTTPS، `CORS_ORIGIN` را روی دامنه‌ی مینی‌اپ بگذار، از دیتابیس بکاپ بگیر.
- `DEV_LOGIN` فقط برای توسعه است و در production غیرفعال می‌ماند.
- بعد از لانچ: referral، تبلیغات و ضدتقلب بیشتر (چند اکانت، الگوی تراکنش) را اضافه کن.

## استقرار رایگان (شروع بدون هزینه)

- **دیتابیس:** Neon (Postgres رایگان). از connection string **direct** (نه pooled) استفاده کن، چون worker از advisory lock نشست‌محور استفاده می‌کند.
- **بک‌اند:** Render (سرویس وب رایگان) با `render.yaml`. حالت `start:all` api + worker + bot را در یک پروسه اجرا می‌کند.
- **بیدار نگه داشتن:** سرویس رایگان Render بعد از ۱۵ دقیقه بی‌درخواستی می‌خوابد. با UptimeRobot (رایگان) هر ۵ دقیقه `/health` را صدا بزن. بلاک‌ها و واریزها هنگام خواب عقب می‌افتند و با بیدار شدن جبران می‌شوند (cursor و catch-up)، ولی برداشت‌ها تا بیدار شدن نمی‌روند.
- **فرانت:** Cloudflare Pages (رایگان، HTTPS با دامنه‌ی pages.dev).
- برای پول واقعی روی mainnet یک سرور همیشه‌روشن (VPS ارزان) بهتر است.


## افزوده‌های نسخه توسعه GnuSilver

- ماینرها ستون `bonus_gh` دارند و Bonus در محاسبه Hash Power شبکه لحاظ می‌شود.
- ماینرهای Event با `is_event=true` و `tradable=false` مشخص می‌شوند.
- endpoint بازیافت: `POST /miners/recycle {minerId}`. فقط Event Miner غیرقابل‌معامله و دارای پاداش تنظیم‌شده قابل بازیافت است.
- تنظیم از مسیر ادمین: `POST /admin/miner-types/:typeId` با فیلدهای `bonusGh`, `rarity`, `isEvent`, `recycleRewardMine` یا `recycleRewardTypeId`. پاداش MINE از حساب خزانه پرداخت می‌شود؛ پیش از فعال‌سازی باید خزانه واقعاً موجودی کافی داشته باشد.
- سابقه Burn در جدول `miner_burns` نگهداری می‌شود و شناسه ماینر اصلی دوباره قابل بازیافت نیست.
- کارمزد پیش‌فرض Marketplace در نسخه جدید ۱٪ است؛ اگر `.env` قدیمی داری، مقدار `MARKET_FEE_BPS=500` را به `100` تغییر بده.

این قابلیت‌ها هنوز نیازمند تست روی دیتابیس آزمایشی هستند. migration جدید `004_miner_economy.sql` باید اجرا شود.
