/**
 * The two pieces of UPnP Findr needs to drive a renderer: reading its device
 * description, and calling actions on its services over SOAP. Renderers'
 * XML is small and regular, so it is read with a handful of patterns rather
 * than a parser.
 */

/** A service a device offers, with its absolute control URL. */
export interface UpnpService {
  serviceType: string;
  controlUrl: string;
}

/** What a device description says about a renderer. */
export interface DeviceDescription {
  udn: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  services: UpnpService[];
}

/**
 * A failed call: a SOAP fault from the device, with its UPnP error code when
 * given, or no answer at all (`answered` false).
 */
export class UpnpError extends Error {
  constructor(
    public readonly action: string,
    public readonly code: number | null,
    message: string,
    public readonly answered = true,
  ) {
    super(`${action} failed: ${message}`);
    this.name = "UpnpError";
  }
}

/** How long a request to a renderer may take unless the caller allows longer. */
const REQUEST_TIMEOUT_MS = 4000;

export class Upnp {
  /** Reads a device description; null when it can't be fetched or isn't a device. */
  public static async describe(location: string): Promise<DeviceDescription | null> {
    let xml: string;
    try {
      const response = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return null;
      xml = await response.text();
    } catch {
      return null;
    }

    // The root device, before any embedded device list
    const device = this.element(xml, "device") ?? "";
    const udn = this.text(device, "UDN");
    if (!udn) return null;

    // A device can embed others (a speaker's media server beside its renderer); read the renderer's services
    const rendererAt = xml.search(/<(?:[\w-]+:)?deviceType>[^<]*:MediaRenderer:/);
    const scope = rendererAt >= 0 ? (this.element(xml.slice(rendererAt), "serviceList") ?? "") : xml;

    // Control URLs are relative to URLBase when given, else to the description, and must stay on the device
    const base = this.text(xml, "URLBase") || location;
    const host = new URL(location).hostname;
    const services: UpnpService[] = [];
    for (const block of this.elements(scope, "service")) {
      const serviceType = this.text(block, "serviceType");
      const control = this.text(block, "controlURL");
      if (!serviceType || !control) continue;
      try {
        const controlUrl = new URL(control, base);
        if (/^https?:$/.test(controlUrl.protocol) && controlUrl.hostname === host) services.push({ serviceType, controlUrl: controlUrl.toString() });
      } catch {
        // An unusable URL is skipped
      }
    }

    return {
      udn,
      name: this.text(device, "friendlyName") || "Unnamed TV",
      manufacturer: this.text(device, "manufacturer") || null,
      model: this.text(device, "modelName") || null,
      services,
    };
  }

  /**
   * Calls a SOAP action and returns the response's fields by name. A request
   * that gets no answer in `timeoutMs` throws a `UpnpError` without a code.
   */
  public static async call(
    service: UpnpService,
    action: string,
    args: Record<string, string | number>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, string>> {
    const fields = Object.entries(args)
      .map(([name, value]) => `<${name}>${this.escape(String(value))}</${name}>`)
      .join("");
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${service.serviceType}">${fields}</u:${action}></s:Body></s:Envelope>`;

    let response: Response;
    try {
      response = await fetch(service.controlUrl, {
        method: "POST",
        headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${service.serviceType}#${action}"` },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UpnpError(action, null, error instanceof Error ? error.message : "no answer", false);
    }

    const xml = await response.text().catch(() => "");
    if (!response.ok) {
      const code = Number(this.text(xml, "errorCode")) || null;
      throw new UpnpError(action, code, this.text(xml, "errorDescription") || `HTTP ${response.status}`);
    }

    // The fields of `<u:ActionResponse>`
    const result: Record<string, string> = {};
    const inner = this.element(xml, `${action}Response`) ?? "";
    for (const match of inner.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const [, name = "", value = ""] = match;
      result[name] = this.unescape(value);
    }
    return result;
  }

  /** Escapes text for an XML element or attribute. */
  public static escape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  // ---------- Reading XML ---------- //

  /** The inner XML of the first element with a local name, whatever its prefix. */
  private static element(xml: string, name: string): string | null {
    const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
    return match?.[1] ?? null;
  }

  /** The inner XML of every element with a local name. */
  private static elements(xml: string, name: string): string[] {
    const pattern = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
    return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
  }

  /** An element's text, unescaped and trimmed; empty when absent. */
  private static text(xml: string, name: string): string {
    return this.unescape(this.element(xml, name) ?? "").trim();
  }

  private static unescape(text: string): string {
    return text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
        // A code point out of range is left as written rather than thrown on
        const value = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), 16) : Number(code);
        return value <= 0x10ffff ? String.fromCodePoint(value) : entity;
      })
      .replace(/&amp;/g, "&");
  }
}
