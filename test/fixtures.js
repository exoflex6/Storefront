// Trimmed storefront v3 response with the fields the bot reads.
import { CURRENCY } from "../src/content.js";

export const SKIN_A = { skin: "skin-a", level: "skin-a-lvl1" };
export const SKIN_B = { skin: "skin-b", level: "skin-b-lvl1" };
export const SKIN_NM = { skin: "skin-nm", level: "skin-nm-lvl1" };
export const BUDDY = { buddy: "buddy-1", level: "buddy-1-lvl1" };

export const fakeCatalog = () => {
    const tier = { name: "Premium", rank: 2, color: 0xd1548d, icon: null };
    const items = new Map();
    const skins = new Map();
    for (const [{ skin, level }, name] of [[SKIN_A, "Prime Vandal"], [SKIN_B, "Reaver Sheriff"], [SKIN_NM, "Oni Phantom"]]) {
        const entry = { uuid: skin, kind: "skin", name, icon: `https://img/${skin}.png`, tier };
        skins.set(skin, entry);
        items.set(skin, entry);
        items.set(level, { ...entry, parentUuid: skin });
    }
    const buddy = { uuid: BUDDY.buddy, kind: "buddy", name: "Lucky Buddy", icon: "https://img/buddy.png" };
    items.set(BUDDY.buddy, buddy);
    items.set(BUDDY.level, { ...buddy, parentUuid: BUDDY.buddy });
    return {
        items,
        skins,
        bundles: new Map([["bundle-asset", { uuid: "bundle-asset", name: "Prime 2.0", icon: "https://img/bundle.png" }]]),
        item(uuid) { return items.get(uuid) ?? { uuid, kind: "unknown", name: "Unknown", icon: null }; },
        wishlistKeyFor(uuid) { const i = items.get(uuid); return i ? (i.parentUuid ?? i.uuid) : null; },
    };
};

const offer = (itemId, cost, currency = CURRENCY.VP) => ({
    OfferID: itemId,
    IsDirectPurchase: true,
    StartDate: "2026-10-21T00:00:00Z",
    Cost: { [currency]: cost },
    Rewards: [{ ItemTypeID: "type", ItemID: itemId, Quantity: 1 }],
});

export const storefront = ({ nightMarket = true } = {}) => ({
    FeaturedBundle: {
        Bundle: null,
        Bundles: [{
            ID: "bundle-id",
            DataAssetID: "bundle-asset",
            CurrencyID: CURRENCY.VP,
            Items: [
                { Item: { ItemTypeID: "t", ItemID: SKIN_A.level, Amount: 1 }, BasePrice: 2175, CurrencyID: CURRENCY.VP, DiscountPercent: 0.33, DiscountedPrice: 1450, IsPromoItem: false },
                { Item: { ItemTypeID: "t", ItemID: BUDDY.level, Amount: 1 }, BasePrice: 475, CurrencyID: CURRENCY.VP, DiscountPercent: 1, DiscountedPrice: 0, IsPromoItem: true },
            ],
            ItemOffers: null,
            TotalBaseCost: { [CURRENCY.VP]: 2650 },
            TotalDiscountedCost: { [CURRENCY.VP]: 1450 },
            TotalDiscountPercent: 0.45,
            DurationRemainingInSeconds: 86400 * 3,
            WholesaleOnly: false,
        }],
        BundleRemainingDurationInSeconds: 86400 * 3,
    },
    SkinsPanelLayout: {
        SingleItemOffers: [SKIN_A.level, SKIN_B.level],
        SingleItemStoreOffers: [offer(SKIN_A.level, 1775), offer(SKIN_B.level, 1275)],
        SingleItemOffersRemainingDurationInSeconds: 3600,
    },
    UpgradeCurrencyStore: { UpgradeCurrencyOffers: [] },
    AccessoryStore: {
        AccessoryStoreOffers: [{ Offer: { ...offer(BUDDY.level, 3000, CURRENCY.KC) }, ContractID: "c" }],
        AccessoryStoreRemainingDurationInSeconds: 7200,
        StorefrontID: "s",
    },
    ...(nightMarket ? {
        BonusStore: {
            BonusStoreOffers: [{
                BonusOfferID: "bonus-1",
                Offer: offer(SKIN_NM.level, 1775),
                DiscountPercent: 40,
                DiscountCosts: { [CURRENCY.VP]: 1065 },
                IsSeen: false,
            }],
            BonusStoreRemainingDurationInSeconds: 600,
        },
    } : {}),
});
