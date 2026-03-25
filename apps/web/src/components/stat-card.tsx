import type { LucideIcon } from "lucide-react"

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string | number
  colorClass?: string
}

export function StatCard({ icon: Icon, label, value, colorClass = "text-findr-tertiary" }: StatCardProps) {
  return (
    <div className="bg-white p-4 rounded-xl border border-findr-border shadow-sm flex flex-col">
      <div className={`flex items-center gap-2 ${colorClass} mb-2`}>
        <Icon className="size-4 opacity-70" />
        <span className="text-xs font-bold uppercase tracking-widest">{label}</span>
      </div>
      <span className="text-2xl font-extrabold text-findr-text">{value}</span>
    </div>
  )
}
