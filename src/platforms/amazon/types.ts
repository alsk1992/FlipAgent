/**
 * Amazon PA-API 5.0 response types
 */

export interface AmazonProduct {
  asin: string;
  title: string;
  price: number;
  listPrice?: number;
  shipping: number;
  inStock: boolean;
  seller: string;
  url: string;
  imageUrl?: string;
  brand?: string;
  category?: string;
  rating?: number;
  reviewCount?: number;
  upc?: string;
}

// PA-API 5.0 SearchItems response
export interface PaApiSearchResponse {
  SearchResult?: {
    TotalResultCount?: number;
    Items?: PaApiItem[];
  };
  Errors?: PaApiError[];
}

// PA-API 5.0 GetItems response
export interface PaApiGetItemsResponse {
  ItemsResult?: {
    Items?: PaApiItem[];
  };
  Errors?: PaApiError[];
}

export interface PaApiItem {
  ASIN: string;
  DetailPageURL?: string;
  ItemInfo?: {
    Title?: { DisplayValue?: string };
    ByLineInfo?: { Brand?: { DisplayValue?: string }; Manufacturer?: { DisplayValue?: string } };
    Classifications?: { Binding?: { DisplayValue?: string }; ProductGroup?: { DisplayValue?: string } };
    ExternalIds?: { UPCs?: { DisplayValues?: string[] }; EANs?: { DisplayValues?: string[] } };
  };
  Offers?: {
    Listings?: PaApiListing[];
    Summaries?: PaApiOfferSummary[];
  };
  Images?: {
    Primary?: {
      Large?: { URL?: string; Width?: number; Height?: number };
      Medium?: { URL?: string };
    };
  };
  BrowseNodeInfo?: {
    BrowseNodes?: Array<{ DisplayName?: string; Id?: string }>;
  };
}

export interface PaApiListing {
  Price?: {
    Amount?: number;
    Currency?: string;
    DisplayAmount?: string;
    Savings?: { Amount?: number; Percentage?: number };
  };
  DeliveryInfo?: {
    IsFreeShippingEligible?: boolean;
    IsAmazonFulfilled?: boolean;
    IsPrimeEligible?: boolean;
  };
  Availability?: {
    Message?: string;
    MinOrderQuantity?: number;
    Type?: string;
  };
  MerchantInfo?: {
    Name?: string;
    Id?: string;
  };
  SavingBasis?: {
    Amount?: number;
  };
}

export interface PaApiOfferSummary {
  LowestPrice?: { Amount?: number; Currency?: string };
  HighestPrice?: { Amount?: number };
  OfferCount?: number;
  Condition?: { Value?: string };
}

export interface PaApiError {
  Code?: string;
  Message?: string;
}

// Re-export SP-API types
export type {
  SpApiCatalogItem,
  SpApiPricingResult,
  SpApiFeeEstimate,
  SpApiOrder,
  SpApiInventorySummary,
  SpApiListingItem,
} from './sp-api';
