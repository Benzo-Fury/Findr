/**
 * # Self Managed Singleton
 * An abstract base class that implements the singleton pattern with type safety.
 * Classes extending this will automatically get singleton behavior and type checking.
 *
 * Uses modern TypeScript features for proper type safety and memory management.
 * Each extending class gets its own singleton instance without interference.
 *
 * ## Usage
 * ```ts
 * class MyService extends SelfManagedSingleton {
 *   public doSomething() {
 *     return "Hello from singleton!";
 *   }
 * }
 *
 * const instance = MyService.getInstance();
 * instance.doSomething(); // Works perfectly with full type safety
 * ```
 */
export default abstract class SelfManagedSingleton {
  // WeakMap to store instances per constructor, ensuring proper garbage collection
  private static readonly instances = new WeakMap<
    new () => SelfManagedSingleton,
    SelfManagedSingleton
  >();

  /**
   * Get or create the singleton instance for the calling class.
   * Uses modern TypeScript features for type safety and proper instance management.
   *
   * @returns The singleton instance of the calling class
   */
  public static getInstance<T extends SelfManagedSingleton>(
    this: new () => T,
  ): T {
    // Check if instance already exists for this constructor
    if (!SelfManagedSingleton.instances.has(this)) {
      // Create new instance and store it
      const instance = new this();
      SelfManagedSingleton.instances.set(this, instance);
    }

    // Return the instance with proper typing
    return SelfManagedSingleton.instances.get(this) as T;
  }

  /**
   * Check if an instance exists for the calling class.
   * Useful for testing or conditional logic.
   *
   * @returns True if an instance exists, false otherwise
   */
  public static hasInstance<T extends SelfManagedSingleton>(
    this: new () => T,
  ): boolean {
    return SelfManagedSingleton.instances.has(this);
  }

  /**
   * Clear the singleton instance for the calling class.
   * Useful for testing or when you need to reset state.
   *
   * @returns True if an instance was cleared, false if none existed
   */
  public static clearInstance<T extends SelfManagedSingleton>(
    this: new () => T,
  ): boolean {
    return SelfManagedSingleton.instances.delete(this);
  }
}
