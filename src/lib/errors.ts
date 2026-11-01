/** Expected failures. GraphQL returns each as a typed error in the mutation's result union. */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export type FieldError = { path: string[]; message: string };

export class ValidationError extends DomainError {
  readonly fieldErrors: FieldError[];
  constructor(message: string, fieldErrors: FieldError[] = []) {
    super("VALIDATION_FAILED", message);
    this.fieldErrors = fieldErrors;
  }
}

export class NotFoundError extends DomainError {
  readonly resource: string;
  readonly lookup: string;
  constructor(resource: string, lookup: string) {
    super("NOT_FOUND", `${resource} ${lookup} was not found`);
    this.resource = resource;
    this.lookup = lookup;
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

export class AuthenticationError extends DomainError {
  constructor(message = "Authentication is required") {
    super("UNAUTHENTICATED", message);
  }
}

export class PermissionDeniedError extends DomainError {
  readonly permission: string;
  constructor(permission: string) {
    super("PERMISSION_DENIED", `Missing permission ${permission}`);
    this.permission = permission;
  }
}

export class InsufficientStockError extends DomainError {
  readonly variantId: string;
  readonly sku: string;
  readonly requested: number;
  readonly available: number;
  constructor(input: { variantId: string; sku: string; requested: number; available: number }) {
    super("INSUFFICIENT_STOCK", `Only ${Math.max(0, input.available)} of ${input.sku} available, ${input.requested} requested`);
    this.variantId = input.variantId;
    this.sku = input.sku;
    this.requested = input.requested;
    this.available = input.available;
  }
}

export class CouponNotApplicableError extends DomainError {
  readonly couponCode: string;
  readonly reason: string;
  constructor(couponCode: string, reason: string) {
    super("COUPON_NOT_APPLICABLE", `Coupon ${couponCode} cannot be applied: ${reason}`);
    this.couponCode = couponCode;
    this.reason = reason;
  }
}

export class CartNotReadyError extends DomainError {
  readonly missing: string[];
  /** The same, field by field. */
  readonly fieldErrors: FieldError[];
  constructor(missing: string[], fieldErrors: FieldError[] = []) {
    super("CART_NOT_READY", `The cart is missing: ${missing.join(", ")}`);
    this.missing = missing;
    this.fieldErrors = fieldErrors;
  }
}

export class PaymentDeclinedError extends DomainError {
  readonly declineCode: string;
  constructor(declineCode: string, message: string) {
    super("PAYMENT_DECLINED", message);
    this.declineCode = declineCode;
  }
}

/** The entity exists but is in a state that does not allow the operation (e.g. refunding more than captured). */
export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super("INVALID_STATE", message);
  }
}
