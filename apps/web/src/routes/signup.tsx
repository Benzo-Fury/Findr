import { SignupForm } from "@/components/signup-form"

export default function Signup() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Findr</h1>
        </div>
        <SignupForm />
      </div>
    </div>
  )
}
