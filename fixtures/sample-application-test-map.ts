import { ApplicationTestMapSchema, type ApplicationTestMap } from "../src/domain/index.js";

/**
 * A realistic, fully curated Application Test Map for a fictional
 * e-commerce staging application ("Shop Staging"). Unlike a freshly
 * discovered draft map (see discovery-to-map.ts), this fixture represents
 * a map a QA engineer has already reviewed and approved: most journeys
 * carry `status: "approved"`, a couple are deliberately left `"draft"`/
 * `"deprecated"` so scope-enforcement tests have real unapproved journeys
 * to exercise, and a handful carry `lastRunOutcome`/`lastRunAt` so
 * `recommendRegressionJourneys` has real failed/flaky/stale signal to
 * work with. Every URL/selector/role here is plausible but fake — nothing
 * in this fixture is ever dispatched against a live browser by the tests
 * that consume it, so schema-validity and semantic plausibility are the
 * only bars it needs to clear. No raw credential, token, PII, or payment
 * value appears anywhere; personas/fixtures only ever carry opaque
 * `credentialReferenceId`/`dataReferenceId` strings.
 */

const DOMAIN = "shop.staging.example.test";
const BASE_URL = `https://${DOMAIN}`;

// Recent vs. stale timestamps are both anchored to this fixed instant so
// the fixture's "stale" journey stays stale and its "recent" journeys stay
// recent no matter when the test suite actually runs — tests that care
// about staleness pass this same instant as recommendRegressionJourneys'
// explicit `now` argument rather than relying on the real wall clock.
const RECENT_RUN_AT = "2026-09-17T08:00:00.000Z";
const STALE_RUN_AT = "2026-07-20T08:00:00.000Z";

const sampleApplicationTestMapData: ApplicationTestMap = {
  id: "map-shop-staging-ecommerce-v1",
  version: "1.4.0",
  applicationName: "Shop Staging",
  targetUrl: BASE_URL,
  environment: "staging",
  approvedScope: {
    allowedDomains: [DOMAIN],
    allowedApiHosts: [`api.${DOMAIN}`],
    allowedMethods: ["GET", "POST", "PUT"],
    executionMode: "safe_test",
  },
  personas: [
    {
      id: "standard_customer",
      name: "Standard Customer",
      description: "A registered, signed-in shopper with an existing order history.",
      credentialReferenceId: "cred-standard-customer",
      permissions: ["place_order", "manage_own_profile", "view_own_orders"],
      allowedEnvironments: ["staging", "development"],
    },
    {
      id: "guest_shopper",
      name: "Guest Shopper",
      description: "An unauthenticated shopper checking out without creating an account.",
      credentialReferenceId: "cred-guest-shopper-session",
      permissions: ["checkout_as_guest"],
      allowedEnvironments: ["staging"],
    },
    {
      id: "admin_reviewer",
      name: "Admin Reviewer",
      description: "A back-office operator who reviews orders and issues refunds.",
      credentialReferenceId: "cred-admin-reviewer",
      permissions: ["view_all_orders", "issue_refund"],
      allowedEnvironments: ["staging"],
    },
  ],
  fixtures: [
    {
      id: "in-stock-product",
      name: "In-Stock Product (Wireless Headphones, SKU-1001)",
      description: "A product with guaranteed available inventory for add-to-cart/checkout journeys.",
      dataReferenceId: "fixture-in-stock-product-sku-1001",
      lockRequired: false,
    },
    {
      id: "out-of-stock-product",
      name: "Out-of-Stock Product (Limited Edition Sneakers, SKU-2002)",
      description: "A product deliberately kept at zero inventory to exercise out-of-stock handling.",
      dataReferenceId: "fixture-out-of-stock-product-sku-2002",
      lockRequired: false,
    },
    {
      id: "valid-coupon-code",
      name: "Valid Coupon Code (SAVE10)",
      description: "A 10%-off coupon with a limited redemption budget shared across test runs.",
      setupAction: "Confirm coupon SAVE10 has redemption budget remaining before use.",
      cleanupAction: "Reset coupon SAVE10's redemption count to its pre-test value.",
      dataReferenceId: "fixture-valid-coupon-save10",
      lockRequired: true,
    },
    {
      id: "sandbox-payment-card",
      name: "Sandbox Payment Card (Visa test card)",
      description: "A shared sandbox payment card number usable by exactly one run at a time.",
      cleanupAction: "Release the sandbox payment card back to the shared pool.",
      dataReferenceId: "fixture-sandbox-payment-card-visa-4242",
      lockRequired: true,
    },
    {
      id: "existing-order",
      name: "Existing Order (ORD-58210)",
      description: "A pre-seeded, already-placed order used by order-history/reorder journeys.",
      dataReferenceId: "fixture-existing-order-ord-58210",
      lockRequired: false,
    },
  ],
  knownConstraints: [
    {
      id: "constraint-legacy-checkout-iframe",
      description:
        "The legacy payment iframe on /checkout/payment cannot be automated via role-based locators; " +
        "only declared_selector_match recovery works there.",
      areaId: "checkout",
      severity: "warning",
    },
  ],
  areas: [
    {
      id: "authentication",
      name: "Authentication",
      description: "Sign-in, sign-out, and account-recovery flows.",
      riskLevel: "high",
      journeys: [
        {
          id: "login_standard_customer",
          areaId: "authentication",
          name: "Standard customer logs in",
          description:
            "A registered customer signs in with valid credentials and reaches their account dashboard.",
          mode: "quick_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-login-success",
              name: "Login succeeds with valid credentials",
              expectedOutcome: "The customer reaches /account after submitting valid credentials.",
              riskLevel: "high",
              requiresApproval: false,
              evidenceRequirements: ["screenshot", "console_log"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/login`, timeoutMs: 10_000 },
                {
                  kind: "fill",
                  selector: "#email",
                  value: "standard.customer@shop.staging.example.test",
                  timeoutMs: 5_000,
                },
                {
                  kind: "fill",
                  selector: "#password",
                  value: "{{cred:standard_customer.password}}",
                  timeoutMs: 5_000,
                },
                { kind: "click", role: "button", name: "Log in", timeoutMs: 5_000 },
                { kind: "waitForUrl", url: `${BASE_URL}/account`, timeoutMs: 10_000 },
              ],
              assertions: [
                { kind: "urlContains", expected: "/account" },
                { kind: "textVisible", target: "h1", expected: "Welcome back" },
              ],
            },
          ],
          allowedRecoveryActions: ["role_name_match", "visible_text_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "password_reset_request",
          areaId: "authentication",
          name: "Password reset request",
          description: "A customer requests a password reset email from the login page.",
          mode: "guided_test",
          requiredPersonaIds: [],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-reset-email-sent",
              name: "Reset email confirmation shown",
              expectedOutcome: "A confirmation message tells the customer to check their email.",
              riskLevel: "medium",
              requiresApproval: true,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/login`, timeoutMs: 10_000 },
                { kind: "click", role: "link", name: "Forgot password?", timeoutMs: 5_000 },
                {
                  kind: "fill",
                  selector: "#email",
                  value: "standard.customer@shop.staging.example.test",
                  timeoutMs: 5_000,
                },
                { kind: "click", role: "button", name: "Send reset link", timeoutMs: 5_000 },
              ],
              assertions: [
                {
                  kind: "textVisible",
                  target: ".form-status",
                  expected: "Check your email for a reset link",
                },
              ],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
      ],
    },
    {
      id: "product-catalogue",
      name: "Product Catalogue",
      description: "Browsing, searching, and filtering the product catalogue.",
      riskLevel: "low",
      journeys: [
        {
          id: "browse_product_catalogue",
          areaId: "product-catalogue",
          name: "Browse product catalogue",
          description: "A visitor loads the catalogue page and sees the product grid render.",
          mode: "quick_test",
          requiredPersonaIds: [],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-catalogue-loads",
              name: "Catalogue page loads",
              expectedOutcome: "The catalogue page renders a non-empty product grid.",
              riskLevel: "low",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [{ kind: "navigate", url: `${BASE_URL}/catalogue`, timeoutMs: 10_000 }],
              assertions: [
                { kind: "titleContains", expected: "Shop" },
                { kind: "elementVisible", target: ".product-grid", expected: "true" },
              ],
            },
          ],
          allowedRecoveryActions: [],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: STALE_RUN_AT,
        },
        {
          id: "product_search_and_filter",
          areaId: "product-catalogue",
          name: "Search and filter products",
          description: "A visitor searches the catalogue and narrows results by keyword.",
          mode: "quick_test",
          requiredPersonaIds: [],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-search-results-render",
              name: "Search returns matching results",
              expectedOutcome: 'Searching for "headphones" shows a filtered results list.',
              riskLevel: "low",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/catalogue`, timeoutMs: 10_000 },
                { kind: "fill", selector: "#search-input", value: "headphones", timeoutMs: 5_000 },
                { kind: "click", role: "button", name: "Search", timeoutMs: 5_000 },
              ],
              assertions: [
                { kind: "urlContains", expected: "q=headphones" },
                { kind: "elementVisible", target: ".search-results", expected: "true" },
              ],
            },
          ],
          allowedRecoveryActions: [],
          // Deliberately left in draft — a QA engineer has not curated this
          // journey's locators against the real search UI yet. Used by the
          // "unapproved journey" scope-enforcement tests.
          status: "draft",
        },
      ],
    },
    {
      id: "cart",
      name: "Cart",
      description: "Adding, updating, and reviewing items in the shopping cart.",
      riskLevel: "medium",
      journeys: [
        {
          id: "add_to_cart",
          areaId: "cart",
          name: "Add product to cart",
          description: "A visitor adds an in-stock product to their cart from its product page.",
          mode: "quick_test",
          requiredPersonaIds: [],
          requiredFixtureIds: ["in-stock-product"],
          checkpoints: [
            {
              id: "checkpoint-cart-badge-increments",
              name: "Cart badge increments",
              expectedOutcome: "The cart badge shows 1 item after adding the product.",
              riskLevel: "medium",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/product/sku-1001`, timeoutMs: 10_000 },
                { kind: "click", role: "button", name: "Add to cart", timeoutMs: 5_000 },
              ],
              assertions: [{ kind: "textVisible", target: ".cart-badge", expected: "1" }],
            },
          ],
          allowedRecoveryActions: ["role_name_match", "visible_text_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "update_cart_quantity",
          areaId: "cart",
          name: "Update cart item quantity",
          description:
            "A customer changes the quantity of an item already in their cart and the subtotal recalculates.",
          mode: "guided_test",
          requiredPersonaIds: [],
          requiredFixtureIds: ["in-stock-product"],
          checkpoints: [
            {
              id: "checkpoint-subtotal-recalculates",
              name: "Subtotal recalculates on quantity change",
              expectedOutcome: "The cart subtotal updates after the quantity field changes.",
              riskLevel: "medium",
              requiresApproval: true,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/cart`, timeoutMs: 10_000 },
                { kind: "fill", selector: "#quantity-sku-1001", value: "3", timeoutMs: 5_000 },
                { kind: "click", role: "button", name: "Update cart", timeoutMs: 5_000 },
              ],
              assertions: [{ kind: "textVisible", target: ".cart-subtotal", expected: "$" }],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "flaky",
          lastRunAt: RECENT_RUN_AT,
        },
      ],
    },
    {
      id: "checkout",
      name: "Checkout",
      description: "Completing a purchase, including guest checkout, coupons, and payment failure handling.",
      riskLevel: "high",
      journeys: [
        {
          id: "registered_customer_checkout",
          areaId: "checkout",
          name: "Registered customer checkout",
          description: "A signed-in customer completes checkout end to end with a sandbox payment card.",
          mode: "controlled_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: ["in-stock-product", "sandbox-payment-card"],
          checkpoints: [
            {
              id: "checkpoint-order-placed",
              name: "Order places successfully",
              expectedOutcome: "The customer reaches the order confirmation page after submitting payment.",
              riskLevel: "high",
              requiresApproval: true,
              evidenceRequirements: ["screenshot", "trace", "api_response"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/checkout`, timeoutMs: 10_000 },
                {
                  kind: "fill",
                  selector: "#shipping-address",
                  value: "1 Market St, Springfield",
                  timeoutMs: 5_000,
                },
                { kind: "select", selector: "#shipping-method", value: "standard", timeoutMs: 5_000 },
                {
                  kind: "fill",
                  selector: "#card-number",
                  value: "{{fixture:sandbox-payment-card.number}}",
                  timeoutMs: 5_000,
                },
                { kind: "click", role: "button", name: "Place order", timeoutMs: 5_000 },
                { kind: "waitForUrl", url: `${BASE_URL}/order-confirmation`, timeoutMs: 15_000 },
              ],
              assertions: [
                { kind: "urlContains", expected: "/order-confirmation" },
                { kind: "textVisible", target: ".order-thank-you", expected: "Thank you for your order" },
              ],
            },
          ],
          allowedRecoveryActions: ["role_name_match", "declared_selector_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "guest_checkout",
          areaId: "checkout",
          name: "Guest checkout",
          description: "An unauthenticated shopper completes checkout without creating an account.",
          mode: "guided_test",
          requiredPersonaIds: ["guest_shopper"],
          requiredFixtureIds: ["in-stock-product"],
          checkpoints: [
            {
              id: "checkpoint-guest-order-placed",
              name: "Guest order places successfully",
              expectedOutcome: "The guest reaches order confirmation without ever creating an account.",
              riskLevel: "high",
              requiresApproval: true,
              evidenceRequirements: ["screenshot", "trace"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/checkout`, timeoutMs: 10_000 },
                { kind: "click", role: "button", name: "Continue as guest", timeoutMs: 5_000 },
                {
                  kind: "fill",
                  selector: "#guest-email",
                  value: "guest.shopper@shop.staging.example.test",
                  timeoutMs: 5_000,
                },
                { kind: "click", role: "button", name: "Place order", timeoutMs: 5_000 },
              ],
              assertions: [{ kind: "urlContains", expected: "/order-confirmation" }],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "invalid_payment_handling",
          areaId: "checkout",
          name: "Invalid payment handling",
          description:
            "Checkout with a declined test card surfaces a clear payment-error message and never places the order.",
          mode: "guided_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: ["in-stock-product", "sandbox-payment-card"],
          checkpoints: [
            {
              id: "checkpoint-payment-declined",
              name: "Declined card surfaces an error",
              expectedOutcome: "A visible error explains the card was declined and no order is created.",
              riskLevel: "high",
              requiresApproval: true,
              evidenceRequirements: ["screenshot", "console_log"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/checkout`, timeoutMs: 10_000 },
                { kind: "fill", selector: "#card-number", value: "4000000000000002", timeoutMs: 5_000 },
                { kind: "click", role: "button", name: "Place order", timeoutMs: 5_000 },
              ],
              assertions: [
                { kind: "textVisible", target: ".payment-error", expected: "Your card was declined" },
              ],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "failed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "coupon_discount_calculation",
          areaId: "checkout",
          name: "Coupon discount calculation",
          description: "Applying a valid coupon code recalculates the cart total with the correct discount.",
          mode: "quick_test",
          requiredPersonaIds: [],
          requiredFixtureIds: ["in-stock-product", "valid-coupon-code"],
          checkpoints: [
            {
              id: "checkpoint-discount-applied",
              name: "Discount line item appears",
              expectedOutcome: "The cart shows a -10% discount line after applying SAVE10.",
              riskLevel: "medium",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/cart`, timeoutMs: 10_000 },
                { kind: "fill", selector: "#coupon-code", value: "SAVE10", timeoutMs: 5_000 },
                { kind: "click", role: "button", name: "Apply", timeoutMs: 5_000 },
              ],
              assertions: [{ kind: "textVisible", target: ".discount-line", expected: "-10%" }],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "order_confirmation",
          areaId: "checkout",
          name: "Order confirmation details",
          description: "The order confirmation/status page shows the correct status for an existing order.",
          mode: "quick_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: ["existing-order"],
          checkpoints: [
            {
              id: "checkpoint-order-status-confirmed",
              name: "Order status reads Confirmed",
              expectedOutcome:
                'Order ORD-58210\'s status page reads "Confirmed" with a visible order summary.',
              riskLevel: "medium",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [{ kind: "navigate", url: `${BASE_URL}/orders/ORD-58210`, timeoutMs: 10_000 }],
              assertions: [
                { kind: "textVisible", target: ".order-status", expected: "Confirmed" },
                { kind: "elementVisible", target: ".order-summary", expected: "true" },
              ],
            },
          ],
          allowedRecoveryActions: [],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
      ],
    },
    {
      id: "orders",
      name: "Orders",
      description: "Viewing order history and re-ordering a previous purchase.",
      riskLevel: "medium",
      journeys: [
        {
          id: "view_order_history",
          areaId: "orders",
          name: "View order history",
          description: "A signed-in customer views their list of past orders.",
          mode: "quick_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-order-history-renders",
              name: "Order history table renders",
              expectedOutcome: "The order history page shows a populated table of past orders.",
              riskLevel: "low",
              requiresApproval: false,
              evidenceRequirements: ["screenshot"],
              steps: [{ kind: "navigate", url: `${BASE_URL}/account/orders`, timeoutMs: 10_000 }],
              assertions: [{ kind: "elementVisible", target: ".order-history-table", expected: "true" }],
            },
          ],
          allowedRecoveryActions: [],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
        {
          id: "reorder_previous_purchase",
          areaId: "orders",
          name: "Reorder a previous purchase",
          description: "A customer reorders an existing order's items directly into a fresh cart.",
          mode: "guided_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: ["existing-order"],
          checkpoints: [
            {
              id: "checkpoint-reorder-populates-cart",
              name: "Reorder populates the cart",
              expectedOutcome: "Clicking Reorder adds the previous order's items to the current cart.",
              riskLevel: "medium",
              requiresApproval: true,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/orders/ORD-58210`, timeoutMs: 10_000 },
                { kind: "click", role: "button", name: "Reorder", timeoutMs: 5_000 },
              ],
              assertions: [{ kind: "elementVisible", target: ".cart-badge", expected: "true" }],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          status: "approved",
          lastRunOutcome: "passed",
          lastRunAt: RECENT_RUN_AT,
        },
      ],
    },
    {
      id: "user-profile",
      name: "User Profile",
      description: "Viewing and editing account profile details.",
      riskLevel: "low",
      journeys: [
        {
          id: "update_profile_details",
          areaId: "user-profile",
          name: "Update profile details",
          description: "A customer edits their display name and saves the change.",
          mode: "guided_test",
          requiredPersonaIds: ["standard_customer"],
          requiredFixtureIds: [],
          checkpoints: [
            {
              id: "checkpoint-profile-saved",
              name: "Profile save confirmation shown",
              expectedOutcome: "A confirmation banner appears after saving the updated display name.",
              riskLevel: "low",
              requiresApproval: true,
              evidenceRequirements: ["screenshot"],
              steps: [
                { kind: "navigate", url: `${BASE_URL}/account/profile`, timeoutMs: 10_000 },
                {
                  kind: "fill",
                  selector: "#display-name",
                  value: "Standard Customer Updated",
                  timeoutMs: 5_000,
                },
                { kind: "click", role: "button", name: "Save changes", timeoutMs: 5_000 },
              ],
              assertions: [
                { kind: "textVisible", target: ".profile-saved-banner", expected: "Profile updated" },
              ],
            },
          ],
          allowedRecoveryActions: ["role_name_match"],
          // Deprecated — the profile UI is being redesigned; kept for
          // reference but no longer runnable. Used by the "unapproved
          // journey" scope-enforcement tests alongside the draft journey
          // above.
          status: "deprecated",
        },
      ],
    },
  ],
  status: "accepted",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-09-17T12:00:00.000Z",
};

export const sampleApplicationTestMap: ApplicationTestMap = ApplicationTestMapSchema.parse(
  sampleApplicationTestMapData,
);
