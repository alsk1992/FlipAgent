/**
 * AliExpress Affiliate/Dropshipping API response types
 */

export interface AliExpressProduct {
  productId: string;
  title: string;
  price: number;
  shipping: number;
  minOrder: number;
  seller: string;
  url: string;
  imageUrl?: string;
  category?: string;
  orders?: number;
}

// Product query response
export interface AliExpressProductQueryResponse {
  resp_result?: {
    resp_code: number;
    resp_msg: string;
    result?: {
      current_page_no: number;
      current_record_count: number;
      total_page_no: number;
      total_record_count: number;
      products?: { product: AliExpressApiProduct[] };
    };
  };
}

// Product detail response
export interface AliExpressProductDetailResponse {
  resp_result?: {
    resp_code: number;
    resp_msg: string;
    result?: {
      current_record_count: number;
      products?: { product: AliExpressApiProduct[] };
    };
  };
}

export interface AliExpressApiProduct {
  product_id: number;
  product_title: string;
  app_sale_price?: string;
  app_sale_price_currency?: string;
  original_price?: string;
  original_price_currency?: string;
  target_app_sale_price?: string;
  target_app_sale_price_currency?: string;
  target_original_price?: string;
  target_original_price_currency?: string;
  sale_price?: string;
  sale_price_currency?: string;
  product_main_image_url?: string;
  product_small_image_urls?: { string: string[] };
  product_detail_url?: string;
  promotion_link?: string;
  second_level_category_id?: number;
  first_level_category_id?: number;
  first_level_category_name?: string;
  second_level_category_name?: string;
  evaluate_rate?: string; // e.g. "96.3%"
  shop_id?: number;
  shop_url?: string;
  latest_volume?: number; // orders in last period
  discount?: string; // e.g. "56%"
  product_video_url?: string;
  relevant_market_commission_rate?: string;
  ship_to_days?: string;
}

// Order placement response
export interface AliExpressPlaceOrderResponse {
  result?: {
    is_success: boolean;
    order_list?: Array<{
      order_id: number;
    }>;
    error_code?: string;
    error_msg?: string;
  };
}

// Hot products response (same structure as product query)
export interface AliExpressHotProductsResponse {
  resp_result?: {
    resp_code: number;
    resp_msg: string;
    result?: {
      current_page_no: number;
      current_record_count: number;
      total_record_count: number;
      products?: { product: AliExpressApiProduct[] };
    };
  };
}

// Category list response
export interface AliExpressCategoryResponse {
  resp_result?: {
    resp_code: number;
    result?: {
      categories?: Array<{
        category_id: number;
        category_name: string;
        parent_category_id?: number;
        is_leaf_category?: boolean;
      }>;
    };
  };
}

// Affiliate link generation response
export interface AliExpressLinkGenerateResponse {
  resp_result?: {
    resp_code: number;
    result?: {
      promotion_links?: Array<{
        promotion_link: string;
        source_value: string;
      }>;
    };
  };
}

// DS (dropshipping) product detail response
export interface AliExpressDsProductResponse {
  result?: {
    product_id: number;
    product_title: string;
    product_price: string;
    product_price_currency: string;
    product_main_image_url?: string;
    package_length?: number;
    package_width?: number;
    package_height?: number;
    package_weight?: string;
    sku_info_list?: Array<{
      sku_id: string;
      sku_price: string;
      sku_stock: boolean;
      sku_attr: string;
    }>;
  };
}

// DS order status response
export interface AliExpressDsOrderStatusResponse {
  result?: {
    order_id: number;
    order_status: string;
    logistics_status?: string;
    order_amount?: { amount: string; currency_code: string };
    gmt_create?: string;
  };
}

// Tracking info response
export interface AliExpressTrackingResponse {
  result?: {
    result_success: boolean;
    details?: {
      details: Array<{
        event_desc: string;
        signed_name?: string;
        status: string;
        address: string;
        event_date: string;
      }>;
    };
    official_website?: string;
  };
}
