# CardRail

One inventory. Every marketplace.

CardRail is the inventory operating system for TCG sellers. Marketplaces connect through adapters. The core only stores a canonical card: identity, language, condition, printing, quantity, price, physical location, and external listings.

```
CardTrader ↔ Adapter ↔ CardRail Core ↔ Adapter ↔ Pokoin
```

This repository is the React demo: scan into a shelf position, reconcile a CardTrader order into one physical pick run, and show Pokoin as a connector rather than the product.
