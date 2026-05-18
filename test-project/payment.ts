export class PaymentGateway {
    public processPayment(amount: number): boolean {
        console.log(`Processing payment of $${amount}`);
        // Simulate a payment process
        return true;
    }
}
