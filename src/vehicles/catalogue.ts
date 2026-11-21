export enum Model { Hatchback = 1, Estate, SUV, SmallVan, DeliveryVan, Lorry }

export const VEHICLES = [
  { model: Model.Hatchback, name: 'Hatchback', shape: 'hatch', length: 3.8, width: 1.7, accel: 1.65, brake: 2.2, speed: 27, colours: [0, 2, 3, 4] },
  { model: Model.Estate, name: 'Estate', shape: 'estate', length: 4.5, width: 1.8, accel: 1.4, brake: 2, speed: 32, colours: [2, 1, 5] },
  { model: Model.SUV, name: 'SUV', shape: 'suv', length: 4.8, width: 2, accel: 1.55, brake: 2, speed: 30, colours: [4, 0, 7] },
  { model: Model.SmallVan, name: 'Small van', shape: 'smallVan', length: 4.4, width: 1.85, accel: 1.2, brake: 1.9, speed: 24, colours: [3, 6, 7] },
  { model: Model.DeliveryVan, name: 'Delivery van', shape: 'deliveryVan', length: 6.2, width: 2.1, accel: 0.95, brake: 1.7, speed: 20, colours: [7, 3, 4] },
  { model: Model.Lorry, name: 'Lorry', shape: 'lorry', length: 10.8, width: 2.5, accel: 0.65, brake: 1.4, speed: 12, colours: [0, 4, 6] },
] as const;

export function vehicleType(model: number) { return VEHICLES[model - 1]!; }

export function throughModel(roll: number): Model {
  if (roll < 0.42) return Model.Hatchback;
  if (roll < 0.67) return Model.Estate;
  if (roll < 0.82) return Model.SUV;
  if (roll < 0.93) return Model.SmallVan;
  return roll < 0.98 ? Model.DeliveryVan : Model.Lorry;
}
