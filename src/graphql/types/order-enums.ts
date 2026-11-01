import { builder } from "../builder.ts";

export const OrderStatusEnum = builder.enumType("OrderStatus", {
  values: { OPEN: { value: "open" }, COMPLETED: { value: "completed" }, CANCELED: { value: "canceled" } } as const,
});

export const PaymentStatusEnum = builder.enumType("PaymentStatus", {
  values: {
    PENDING: { value: "pending", description: "Awaiting payment (e.g. bank transfer)." },
    AUTHORIZED: { value: "authorized" },
    PARTIALLY_PAID: { value: "partially_paid" },
    PAID: { value: "paid" },
    PARTIALLY_REFUNDED: { value: "partially_refunded" },
    REFUNDED: { value: "refunded" },
    VOIDED: { value: "voided" },
  } as const,
});

export const FulfillmentStatusEnum = builder.enumType("FulfillmentStatus", {
  values: { UNFULFILLED: { value: "unfulfilled" }, PARTIALLY_FULFILLED: { value: "partially_fulfilled" }, FULFILLED: { value: "fulfilled" } } as const,
});
