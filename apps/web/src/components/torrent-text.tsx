import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"

interface TorrentTextProps {
  children: string
  className?: string
}

export function TorrentText({ children, className }: TorrentTextProps) {
  return (
    <HoverCard>
      <HoverCardTrigger
        render={<span />}
        className={cn("underline decoration-dotted underline-offset-2", className)}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="font-medium">What are torrents?</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Think of a "torrent" as a "download". Findr scans the web for different downloads (torrents) for your specific show. 
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
