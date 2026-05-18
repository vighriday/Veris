export interface Item {
    id: string;
    price: number;
    name: string;
}

export class ShoppingCart {
    private items: Item[] = [];

    public addItem(item: Item): void {
        this.items.push(item);
        console.log(`Added ${item.name} to cart.`);
    }

    public calculateTotal(): number {
        return this.items.reduce((total, item) => total + item.price, 0);
    }

    public getItems(): Item[] {
        return this.items;
    }
}
