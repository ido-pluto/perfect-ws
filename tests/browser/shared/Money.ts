import { TransformInstruction } from 'perfect-ws/browser';

export class Money {
  constructor(public cents: number, public currency: string) {}
}

export class MoneyTransform extends TransformInstruction<Money> {
  uniqueId = 'browser-acceptance.money';

  check(value: unknown): value is Money {
    return value instanceof Money;
  }

  serialize(value: Money) {
    return { cents: value.cents, currency: value.currency };
  }

  deserialize(value: { cents: number; currency: string }) {
    return new Money(value.cents, value.currency);
  }
}
