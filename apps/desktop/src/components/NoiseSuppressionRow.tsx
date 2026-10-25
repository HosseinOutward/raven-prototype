import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import type { NoiseSuppressionDepth, NoiseSuppressionMode, NoiseSuppressionRuntime } from "@/lib/audio";
import {
  NOISE_SUPPRESSION_DEPTH_CAPTION,
  NOISE_SUPPRESSION_DEPTH_LABEL,
  NOISE_SUPPRESSION_DEPTHS,
  NOISE_SUPPRESSION_LABEL,
  NOISE_SUPPRESSION_MODES,
  noiseSuppressionCaption,
} from "@/lib/noiseSuppression";
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
      {value ? (
        // When something else runs than was chosen, the line says so a step louder; never
        // as a warning, since the microphone is still heard.
        <p className={cn("mt-1 text-caption", runtime && runtime.active !== value ? "text-muted-foreground" : "text-subtle")}>
          {noiseSuppressionCaption(value, runtime)}
        </p>
      ) : null}
    </div>
  );
}

/** How much the noise suppression takes out, for the Mixer. */
export function NoiseSuppressionDepthRow({
  value,
  disabled,
  onChange,
  className,
}: {
  value: NoiseSuppressionDepth;
  disabled?: boolean;
  onChange: (depth: NoiseSuppressionDepth) => void;
  className?: string;
}) {
  const caption = NOISE_SUPPRESSION_DEPTH_CAPTION[value];
  return (
    <fieldset disabled={disabled} className={cn("m-0 min-w-0 border-0", className, disabled && "opacity-45")}>
      <span className="mb-2 block text-small">How much to remove</span>
      <Tabs
        value={value}
        onValueChange={(depth) => onChange(depth as NoiseSuppressionDepth)}
        tabs={NOISE_SUPPRESSION_DEPTHS.map((depth) => ({
          value: depth,
          label: NOISE_SUPPRESSION_DEPTH_LABEL[depth],
          content: null,
        }))}
      />
      {caption ? <p className="mt-1 text-caption text-subtle">{caption}</p> : null}
    </fieldset>
  );
}
