# GnuSilver development pass

Changes applied to the supplied `arena-mining-full-3.zip` source:

- Added migration `backend/migrations/004_miner_economy.sql` for miner bonus power, rarity, Event Miner metadata, configurable recycling rewards, and permanent miner burn history.
- Mining hash calculations now include each miner type's `bonus_gh`.
- Added `POST /miners/recycle` and `GET /miners/burns` authenticated endpoints.
- Added Inventory UI controls for recycling eligible Event Miners and viewing recycling history.
- Added admin miner-type configuration fields: `bonusGh`, `rarity`, `isEvent`, `recycleRewardMine`, and `recycleRewardTypeId`.
- Added an example non-tradable Event Miner (`event_spark`). Its recycling reward is intentionally unset until configured by the project admin.
- Changed the default Marketplace fee from 5% to 1% (`MARKET_FEE_BPS=100`). Existing deployments must update their `.env` explicitly.

## Not implemented / not production-ready

- Real TON advertiser payment/escrow for sponsored tasks. Existing sponsored promotions still use the existing MINE-budget flow.
- A complete timed event creation/scheduling UI and event administration workflow.
- On-chain Jetton burn for MINE. Existing ledger `burn` accounting is internal accounting and must not be represented as proof that Jetton total supply has been burned on-chain.
- New LP integration, multi-currency support, BTC/ETH, or exchange features.
- Full automated integration tests against PostgreSQL and TON testnet.

Apply migrations before running the updated backend. Configure recycling rewards only after confirming the treasury has enough MINE or the configured reward miner type exists. Test on a disposable database and TON testnet before any public launch.
