declare module "popbill" {
  const popbill: {
    config(options: Record<string, unknown>): void;
    TaxinvoiceService(): unknown;
    EasyFinBankService(): unknown;
    MessageService(): unknown;
  };
  export default popbill;
}
