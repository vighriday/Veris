import { ShoppingCart } from './cart';
import { PaymentGateway } from './payment';

export class CheckoutService {
    private paymentGateway: PaymentGateway;

    constructor() {
        this.paymentGateway = new PaymentGateway();
    }

    public executeCheckout(cart: ShoppingCart): boolean {
        const total = cart.calculateTotal();
        if (total === 0) {
            console.log("Cart is empty. Cannot checkout.");
            return false;
        }

        console.log(`Starting checkout for total: $${total}`);
        const paymentSuccess = this.paymentGateway.processPayment(total);

        if (paymentSuccess) {
            console.log("Checkout successful!");
            return true;
        } else {
            console.log("Checkout failed!");
            return false;
        }
    }
}
