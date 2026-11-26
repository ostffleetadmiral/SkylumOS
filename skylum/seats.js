// seats.js — SKYLUM task/seat scheduler: fuel-metered cooperative lanes.
// QSC-V1 convention: seats get deterministic fuel budgets; a task is a
// generator that yields once per step. The scheduler advances each ready
// seat by one quantum per tick — deterministic, no wall-clock in the
// core path. Receipts record steps/fuel for audit.

export class Seat {
  constructor(id, fuel) {
    this.id = id;
    this.fuelMax = fuel;      // budget granted at seat() time
    this.fuel = fuel;         // remaining fuel units
    this.task = null;         // generator
    this.steps = 0;
    this.done = false;
    this.result = undefined;
  }

  submit(taskFn, fuel = this.fuelMax) {
    // taskFn: generator function — each .next() = one step
    this.task = taskFn();
    this.fuel = fuel;
    this.steps = 0;
    this.done = false;
    return this;
  }

  // advance one step; returns true while task alive
  step() {
    if (!this.task || this.done || this.fuel <= 0) { this.done = true; return false; }
    const r = this.task.next();
    this.fuel -= 1;
    this.steps += 1;
    if (r.done) { this.done = true; this.result = r.value; }
    return !this.done;
  }
}

export class Scheduler {
  constructor(iteron = null) {
    this.iteron = iteron;
    this.seats = new Map();
    this.receipts = [];
    this.tickCount = 0;
  }

  seat(id, fuel = 1024) {
    const s = new Seat(id, fuel);
    this.seats.set(id, s);
    return s;
  }

  submit(id, taskFn, fuel) {
    let s = this.seats.get(id);
    if (!s) s = this.seat(id);
    return s.submit(taskFn, fuel ?? s.fuelMax);
  }

  // one scheduling quantum: every live seat advances one step (round-robin
  // order = insertion order — deterministic)
  tick() {
    this.tickCount += 1;
    let ran = 0;
    for (const s of this.seats.values()) {
      if (s.step()) ran += 1;
    }
    return ran;
  }

  // run until all seats done or maxTicks — returns receipts.
  // maxTicks bounds THIS run, not the scheduler's lifetime.
  run(maxTicks = 1 << 20) {
    const start = this.tickCount;
    while (this.tickCount - start < maxTicks) {
      const ran = this.tick();
      if (ran === 0) break;
    }
    return this.receipt();
  }

  receipt() {
    const r = {
      tick: this.tickCount,
      seats: [...this.seats.values()].map(s => ({
        id: s.id, steps: s.steps, fuel_left: Math.max(0, s.fuel), done: s.done,
      })),
    };
    this.receipts.push(r);
    return r;
  }
}
