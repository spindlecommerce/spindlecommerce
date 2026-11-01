/** Email copy; other languages fall back to English. Plain text: templates escape it for HTML. */
const en = {
  hello: (name: string | null) => (name ? `Hi ${name},` : "Hello,"),
  help: "Questions? Reply to this email.",
  item: "Item",
  qty: "Qty",
  amount: "Total",
  subtotal: "Subtotal",
  discount: "Discount",
  shipping: "Shipping",
  tax: "Tax",
  taxIncluded: "Includes tax",
  total: "Total",
  shippingAddress: "Shipping address",
  billingAddress: "Billing address",
  linkFallback: "Or paste this link into your browser:",
  confirmation: {
    subject: (number: string) => `Order ${number} confirmed`,
    intro: "Thanks for your order. We'll email you again when it ships.",
    introDigital: "Thanks for your order.",
  },
  shipped: {
    subject: (number: string) => `Your order ${number} has shipped`,
    intro: "Good news: your order is on its way.",
    introPartial: "Part of your order is on its way. We'll email you when the rest ships.",
    inShipment: "In this shipment",
    tracking: "Tracking",
    track: "Track your parcel",
  },
  refunded: {
    subject: (number: string) => `Refund for order ${number}`,
    intro: (amount: string) => `We've refunded ${amount} to your original payment method. It can take a few days to show up.`,
    introNoAmount: "We've refunded part of your order to your original payment method. It can take a few days to show up.",
    refund: "Refund",
  },
  canceled: {
    subject: (number: string) => `Order ${number} canceled`,
    intro: "Your order has been canceled. You won't be charged for it.",
    declined: "We couldn't take payment, so your order has been canceled. You won't be charged for it.",
  },
  customerReset: {
    subject: "Reset your password",
    intro: (store: string) => `Someone asked to reset the password for your ${store} account. Choose a new one with the button below.`,
    button: "Choose a new password",
    note: "The link works once and expires soon. If you didn't ask for this, ignore this email: your password stays the same.",
  },
  staffReset: {
    subject: (store: string) => `Reset your ${store} admin password`,
    intro: (store: string) => `Someone asked to reset your password for the ${store} admin. Choose a new one with the button below.`,
  },
  newOrder: {
    subject: (number: string, total: string) => `New order ${number} (${total})`,
    intro: (customer: string, number: string, total: string, channel: string) => `${customer} placed order ${number} for ${total} in ${channel}.`,
    button: "View order",
  },
  lowStock: {
    subject: (sku: string, quantity: number) => `Low stock: ${sku} (${quantity} left)`,
    intro: (name: string, sku: string, quantity: number, location: string, threshold: number) =>
      `${name} (${sku}) is down to ${quantity} at ${location}. Your alert threshold is ${threshold}.`,
    button: "View inventory",
  },
  test: {
    subject: (store: string) => `Test email from ${store}`,
    intro: (provider: string) => `This is a test email sent with ${provider}. If you can read it, your email setup works.`,
  },
};

export type Strings = typeof en;

const de: Strings = {
  hello: (name) => (name ? `Hallo ${name},` : "Hallo,"),
  help: "Fragen? Antworten Sie einfach auf diese E-Mail.",
  item: "Artikel",
  qty: "Menge",
  amount: "Summe",
  subtotal: "Zwischensumme",
  discount: "Rabatt",
  shipping: "Versand",
  tax: "Steuern",
  taxIncluded: "Enthaltene MwSt.",
  total: "Gesamt",
  shippingAddress: "Lieferadresse",
  billingAddress: "Rechnungsadresse",
  linkFallback: "Oder fügen Sie diesen Link in Ihren Browser ein:",
  confirmation: {
    subject: (number) => `Bestellung ${number} bestätigt`,
    intro: "Vielen Dank für Ihre Bestellung. Wir schreiben Ihnen wieder, sobald sie versandt wird.",
    introDigital: "Vielen Dank für Ihre Bestellung.",
  },
  shipped: {
    subject: (number) => `Ihre Bestellung ${number} wurde versandt`,
    intro: "Gute Nachrichten: Ihre Bestellung ist unterwegs.",
    introPartial: "Ein Teil Ihrer Bestellung ist unterwegs. Wir schreiben Ihnen, sobald der Rest versandt wird.",
    inShipment: "In dieser Sendung",
    tracking: "Sendungsnummer",
    track: "Sendung verfolgen",
  },
  refunded: {
    subject: (number) => `Erstattung für Bestellung ${number}`,
    intro: (amount) => `Wir haben ${amount} auf Ihre ursprüngliche Zahlungsart erstattet. Es kann einige Tage dauern, bis der Betrag erscheint.`,
    introNoAmount: "Wir haben einen Teil Ihrer Bestellung auf Ihre ursprüngliche Zahlungsart erstattet. Es kann einige Tage dauern, bis der Betrag erscheint.",
    refund: "Erstattung",
  },
  canceled: {
    subject: (number) => `Bestellung ${number} storniert`,
    intro: "Ihre Bestellung wurde storniert. Ihnen wird nichts berechnet.",
    declined: "Die Zahlung ist fehlgeschlagen, daher wurde Ihre Bestellung storniert. Ihnen wird nichts berechnet.",
  },
  customerReset: {
    subject: "Passwort zurücksetzen",
    intro: (store) => `Für Ihr Konto bei ${store} wurde ein neues Passwort angefordert. Wählen Sie es über die Schaltfläche unten.`,
    button: "Neues Passwort wählen",
    note: "Der Link funktioniert einmal und läuft bald ab. Falls Sie das nicht angefordert haben, ignorieren Sie diese E-Mail: Ihr Passwort bleibt unverändert.",
  },
  staffReset: {
    subject: (store) => `Admin-Passwort für ${store} zurücksetzen`,
    intro: (store) => `Für Ihren Admin-Zugang zu ${store} wurde ein neues Passwort angefordert. Wählen Sie es über die Schaltfläche unten.`,
  },
  newOrder: {
    subject: (number, total) => `Neue Bestellung ${number} (${total})`,
    intro: (customer, number, total, channel) => `${customer} hat in ${channel} die Bestellung ${number} über ${total} aufgegeben.`,
    button: "Bestellung ansehen",
  },
  lowStock: {
    subject: (sku, quantity) => `Niedriger Bestand: ${sku} (noch ${quantity})`,
    intro: (name, sku, quantity, location, threshold) => `${name} (${sku}) ist am Standort ${location} auf ${quantity} gesunken. Ihr Schwellenwert ist ${threshold}.`,
    button: "Bestand ansehen",
  },
  test: {
    subject: (store) => `Test-E-Mail von ${store}`,
    intro: (provider) => `Dies ist eine Test-E-Mail, gesendet mit ${provider}. Wenn Sie sie lesen können, funktioniert Ihr E-Mail-Versand.`,
  },
};

// French puts a non-breaking space before ? : and ; ( ).
const fr: Strings = {
  hello: (name) => (name ? `Bonjour ${name},` : "Bonjour,"),
  help: "Une question ? Répondez simplement à cet e-mail.",
  item: "Article",
  qty: "Qté",
  amount: "Total",
  subtotal: "Sous-total",
  discount: "Remise",
  shipping: "Livraison",
  tax: "Taxes",
  taxIncluded: "Dont TVA",
  total: "Total",
  shippingAddress: "Adresse de livraison",
  billingAddress: "Adresse de facturation",
  linkFallback: "Ou collez ce lien dans votre navigateur :",
  confirmation: {
    subject: (number) => `Commande ${number} confirmée`,
    intro: "Merci pour votre commande. Nous vous écrirons dès son expédition.",
    introDigital: "Merci pour votre commande.",
  },
  shipped: {
    subject: (number) => `Votre commande ${number} a été expédiée`,
    intro: "Bonne nouvelle : votre commande est en route.",
    introPartial: "Une partie de votre commande est en route. Nous vous écrirons dès l'expédition du reste.",
    inShipment: "Dans ce colis",
    tracking: "Numéro de suivi",
    track: "Suivre mon colis",
  },
  refunded: {
    subject: (number) => `Remboursement de la commande ${number}`,
    intro: (amount) => `Nous avons remboursé ${amount} sur votre moyen de paiement d'origine. Le montant peut mettre quelques jours à apparaître.`,
    introNoAmount: "Nous avons remboursé une partie de votre commande sur votre moyen de paiement d'origine. Le montant peut mettre quelques jours à apparaître.",
    refund: "Remboursement",
  },
  canceled: {
    subject: (number) => `Commande ${number} annulée`,
    intro: "Votre commande a été annulée. Aucun montant ne vous sera débité.",
    declined: "Le paiement n'a pas abouti, votre commande a donc été annulée. Aucun montant ne vous sera débité.",
  },
  customerReset: {
    subject: "Réinitialisez votre mot de passe",
    intro: (store) => `Une réinitialisation du mot de passe de votre compte ${store} a été demandée. Choisissez-en un nouveau avec le bouton ci-dessous.`,
    button: "Choisir un nouveau mot de passe",
    note: "Le lien ne fonctionne qu'une fois et expire bientôt. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.",
  },
  staffReset: {
    subject: (store) => `Réinitialisez votre mot de passe d'administration ${store}`,
    intro: (store) => `Une réinitialisation de votre mot de passe pour l'administration de ${store} a été demandée. Choisissez-en un nouveau avec le bouton ci-dessous.`,
  },
  newOrder: {
    subject: (number, total) => `Nouvelle commande ${number} (${total})`,
    intro: (customer, number, total, channel) => `${customer} a passé la commande ${number} pour ${total} sur ${channel}.`,
    button: "Voir la commande",
  },
  lowStock: {
    subject: (sku, quantity) => `Stock bas : ${sku} (reste ${quantity})`,
    intro: (name, sku, quantity, location, threshold) => `${name} (${sku}) est descendu à ${quantity} à ${location}. Votre seuil d'alerte est de ${threshold}.`,
    button: "Voir le stock",
  },
  test: {
    subject: (store) => `E-mail de test de ${store}`,
    intro: (provider) => `Ceci est un e-mail de test envoyé avec ${provider}. Si vous pouvez le lire, votre configuration fonctionne.`,
  },
};

const STRINGS: Record<string, Strings> = { en, de, fr };

export const language = (locale: string) => locale.split("-")[0]!.toLowerCase();

/** The strings for a locale's language (`de-DE` → German), English otherwise. */
export const stringsFor = (locale: string): Strings => STRINGS[language(locale)] ?? en;

/** Languages with their own copy, for the admin's preview picker. */
export const LANGUAGES = Object.keys(STRINGS);
