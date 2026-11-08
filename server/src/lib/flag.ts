/** An on/off setting from the environment: "true", "1", "yes" or "on" (any case) is on; anything else, or unset, is off. */
export const isOn = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim())
