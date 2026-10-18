import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NoiseSuppressionMode, NoiseSuppressionRuntime } from "@/lib/audio";
import { NOISE_SUPPRESSION_LABEL, NOISE_SUPPRESSION_MODES, noiseSuppressionCaption } from "@/lib/noiseSuppression";
import { cn } from "@/lib/utils";

/** The microphone's noise suppression mode with a line on what it does. `value` is null until there is a microphone to ask. */
export function NoiseSuppressionRow({
  value,
  runtime,
  disabled,
  onChange,
  className,
}: {
  value: NoiseSuppressionMode | null;
  runtime?: NoiseSuppressionRuntime | null;
  disabled?: boolean;
  onChange: (mode: NoiseSuppressionMode) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <span className={cn("text-small", disabled && "opacity-45")}>Noise suppression</span>
        <Select value={value ?? ""} disabled={disabled} onValueChange={(mode) => onChange(mode as NoiseSuppressionMode)}>
          <SelectTrigger size="sm" className="w-28" aria-label="Noise suppression">
            <SelectValue placeholder="—">{value ? NOISE_SUPPRESSION_LABEL[value] : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {NOISE_SUPPRESSION_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {NOISE_SUPPRESSION_LABEL[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value ? <p className="mt-1 text-caption text-subtle">{noiseSuppressionCaption(value, runtime)}</p> : null}
    </div>
  );
}
