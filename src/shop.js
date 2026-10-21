import { CURRENCY } from "./content.js";

/**
 * Normalize a /store/v3/storefront response into the four sections the bot shows.
 * Reset times come from the response's remaining-duration fields, never hardcoded.
 * @param {any} raw storefront JSON
 * @param {import("./content.js").Catalog} catalog
 * @param {number} now ms timestamp the response was fetched at
 */
export const parseStorefront = (raw, catalog, now = Date.now()) => {
    const at = (seconds) => (typeof seconds === "number" ? now + seconds * 1000 : null);
    const firstReward = (offer) => offer?.Rewards?.[0];

    const skinsPanel = raw.SkinsPanelLayout ?? {};
    const daily = {
        resetsAt: at(skinsPanel.SingleItemOffersRemainingDurationInSeconds),
        items: (skinsPanel.SingleItemStoreOffers ?? []).map((offer) => {
            const itemId = firstReward(offer)?.ItemID ?? offer.OfferID;
            return {
                ...catalog.item(itemId),
                key: catalog.wishlistKeyFor(itemId),
                price: offer.Cost?.[CURRENCY.VP] ?? null,
            };
        }),
    };

    const accessoryStore = raw.AccessoryStore ?? {};
    const accessories = {
        resetsAt: at(accessoryStore.AccessoryStoreRemainingDurationInSeconds),
        items: (accessoryStore.AccessoryStoreOffers ?? []).map(({ Offer }) => {
            const reward = firstReward(Offer);
            const itemId = reward?.ItemID ?? Offer.OfferID;
            return {
                ...catalog.item(itemId),
                key: catalog.wishlistKeyFor(itemId),
                quantity: reward?.Quantity ?? 1,
                price: Offer.Cost?.[CURRENCY.KC] ?? null,
            };
        }),
    };

    // BonusStore is absent outside night market windows.
    const nightMarket = raw.BonusStore ? {
        resetsAt: at(raw.BonusStore.BonusStoreRemainingDurationInSeconds),
        items: (raw.BonusStore.BonusStoreOffers ?? []).map((bonus) => {
            const itemId = firstReward(bonus.Offer)?.ItemID;
            return {
                ...catalog.item(itemId),
                key: catalog.wishlistKeyFor(itemId),
                basePrice: bonus.Offer.Cost?.[CURRENCY.VP] ?? null,
                price: bonus.DiscountCosts?.[CURRENCY.VP] ?? null,
                discountPercent: bonus.DiscountPercent ?? 0,
                seen: Boolean(bonus.IsSeen),
            };
        }),
    } : null;

    const featured = raw.FeaturedBundle ?? {};
    const bundleList = featured.Bundles?.length ? featured.Bundles : (featured.Bundle ? [featured.Bundle] : []);
    const bundles = bundleList.map((bundle) => {
        const meta = catalog.bundles.get(bundle.DataAssetID) ?? { name: "Featured bundle", icon: null };
        return {
            uuid: bundle.DataAssetID,
            name: meta.name,
            icon: meta.icon,
            resetsAt: at(bundle.DurationRemainingInSeconds ?? featured.BundleRemainingDurationInSeconds),
            price: bundle.TotalDiscountedCost?.[CURRENCY.VP] ?? sum(bundle.Items, "DiscountedPrice"),
            basePrice: bundle.TotalBaseCost?.[CURRENCY.VP] ?? sum(bundle.Items, "BasePrice"),
            wholesaleOnly: Boolean(bundle.WholesaleOnly),
            items: (bundle.Items ?? []).map((entry) => ({
                ...catalog.item(entry.Item.ItemID),
                quantity: entry.Item.Amount ?? entry.Item.Quantity ?? 1,
                price: entry.DiscountedPrice,
                basePrice: entry.BasePrice,
                promo: Boolean(entry.IsPromoItem),
            })),
        };
    });

    return { fetchedAt: now, daily, accessories, nightMarket, bundles };
};

const sum = (items = [], key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);

/** Whether a parsed shop item is on the wishlist (keys are top-level item UUIDs). */
export const isWishlisted = (item, wishlist) => Boolean(item.key) && wishlist.includes(item.key);

/** Wishlisted items present in the daily shop, accessory store or night market. */
export const findWishlistHits = (shop, wishlist) => {
    const match = (items) => items.filter((item) => isWishlisted(item, wishlist));
    return {
        daily: match(shop.daily.items),
        accessories: match(shop.accessories.items),
        nightMarket: shop.nightMarket ? match(shop.nightMarket.items) : [],
    };
};

/** Stable key for an offer set, used to avoid re-alerting on the same shop. */
export const offerKey = (items) => items.map((item) => item.uuid).sort().join(",");
