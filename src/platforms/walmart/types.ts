/**
 * Walmart Affiliate API response types
 */

export interface WalmartProduct {
  itemId: string;
  title: string;
  price: number;
  shipping: number;
  inStock: boolean;
  seller: string;
  url: string;
  imageUrl?: string;
  upc?: string;
  category?: string;
}

// Walmart Affiliate API search response
export interface WalmartSearchResponse {
  query?: string;
  sort?: string;
  responseGroup?: string;
  totalResults: number;
  start: number;
  numItems: number;
  items?: WalmartApiItem[];
}

// Walmart Affiliate API item
export interface WalmartApiItem {
  itemId: number;
  parentItemId?: number;
  name: string;
  msrp?: number;
  salePrice?: number;
  upc?: string;
  categoryPath?: string;
  shortDescription?: string;
  longDescription?: string;
  brandName?: string;
  thumbnailImage?: string;
  mediumImage?: string;
  largeImage?: string;
  productTrackingUrl?: string;
  standardShipRate?: number;
  marketplace?: boolean;
  sellerInfo?: string;
  productUrl?: string;
  availableOnline?: boolean;
  stock?: string; // "Available" | "Not available" | "Limited Supply"
  customerRating?: string; // "4.5" etc
  numReviews?: number;
  offerType?: string;
  isTwoDayShippingEligible?: boolean;
  freeShippingOver35Dollars?: boolean;
  categoryNode?: string;
  bundle?: boolean;
  clearance?: boolean;
  preOrder?: boolean;
  size?: string;
  color?: string;
  gender?: string;
  age?: string;
}

// Walmart item lookup response (single item or array)
export interface WalmartItemResponse {
  items?: WalmartApiItem[];
}

// Re-export seller types
export type {
  WalmartSellerItem,
  WalmartOrder as WalmartSellerOrder,
  WalmartInventoryItem,
  WalmartFeedResponse,
} from './seller';
