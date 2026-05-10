export class ServiceRegistry {
  private readonly services = new Map<string, unknown>()

  set<T>(name: string, service: T): void {
    this.services.set(name, service)
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  require<T>(name: string): T {
    const service = this.get<T>(name)
    if (service === undefined) throw new Error(`Service not registered: ${name}`)
    return service
  }

  clear(): void {
    this.services.clear()
  }

  keys(): string[] {
    return [...this.services.keys()].sort()
  }
}
