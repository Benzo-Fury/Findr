/** A JPEG imported `with { type: "file" }`: its path, embedded in the compiled build. */
declare module "*.jpg" {
  const path: string
  export default path
}
