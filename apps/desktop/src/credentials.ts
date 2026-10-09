type Operations = {
  load(origin: string): Promise<string | null>
  save(origin: string, token: string): Promise<void>
  clear(origin: string): Promise<void>
}
type Slot = { tail: Promise<void>; owner: symbol | null }
const slots = new Map<string, Slot>()
export class CredentialStore {
  private readonly identity = Symbol()
  private restored = false
  constructor(
    private readonly origin: string,
    private readonly operations: Operations,
  ) {}
  private serialize<T>(operation: (slot: Slot) => Promise<T>): Promise<T> {
    const slot = slots.get(this.origin) ?? { tail: Promise.resolve(), owner: null }
    slots.set(this.origin, slot)
    const result = slot.tail.then(() => operation(slot))
    slot.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  async restore(active: () => boolean): Promise<string | null> {
    if (this.restored) return null
    return this.serialize(async (slot) => {
      if (!active() || this.restored) return null
      const token = await this.operations.load(this.origin)
      if (!active()) return null
      this.restored = true
      if (token) slot.owner = this.identity
      return token
    })
  }
  async remember(token: string, active: () => boolean): Promise<boolean> {
    return this.serialize(async (slot) => {
      if (!active()) return false
      await this.operations.save(this.origin, token)
      slot.owner = this.identity
      if (!active()) {
        await this.operations.clear(this.origin)
        slot.owner = null
        return false
      }
      return true
    })
  }
  async forget() {
    await this.serialize(async (slot) => {
      if (slot.owner !== this.identity) return
      await this.operations.clear(this.origin)
      slot.owner = null
    })
  }
}
