# Limitra Product Sourcer (Chrome Extension)

Chrome Manifest V3 extension for sourcing products directly from **Amazon, eBay, Walmart**, and future marketplaces into Limitra's AI Review & Storefront catalog.

## Features
- **Cart Icon on Every Product:** Injects a Shadow-DOM **Add to Limitra** button on search/listing cards and product detail pages.
- **Full Price & Variation Extraction:** Captures base price, original/list price, currency, shipping, weight, gallery images, specifications, and product variations with per-variation prices.
- **AI Review & NGN Pricing:** Runs Limitra's `POST /api/v1/sourcing/extension-review` (`ProductContentEnhancer` + `ProductPricingService`) to optimize title, description, category, SEO metadata, and NGN landed prices before publishing.
- **Direct Official Publish:** Publishes directly to Limitra (`POST /api/v1/sourcing/extension-import`) as `active` (or `draft`) along with all `ProductVariant` rows.

## Load Unpacked in Chrome
1. Open `chrome://extensions` in Chrome/Edge/Brave.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`limitra-extension`).
4. Click the extension icon to open the Side Panel, sign in under **Account**, and browse Amazon, eBay, or Walmart.

