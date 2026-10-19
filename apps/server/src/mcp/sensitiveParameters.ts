import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

/**
 * Marks a tool whose parameters carry secret values. Effect's
 * `Toolkit.handle` records the raw parameters as a `parameters` attribute on
 * the current span, which the trace file and every OTLP exporter then keep.
 */
export const SensitiveParameters = Context.Reference<boolean>("t3/mcp/SensitiveParameters", {
  defaultValue: () => false,
});

const HIDDEN_ATTRIBUTE = "parameters";

// `Toolkit.handle` annotates `fiber.currentSpanLocal`, so a stand-in parent
// that drops the attribute keeps the real span, its ids and its children
// intact while the value never reaches a tracer.
export const withoutParametersAttribute = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.updateContext((context: Context.Context<R>) => {
      const parent = Context.getOrUndefined(context, Tracer.ParentSpan);
      if (parent === undefined || parent._tag !== "Span") return context;
      // A Proxy, not a derived object: `NativeSpan` caches its trace and span ids
      // lazily on `this`, so a copy would mint ids that differ from the real span's.
      const filtered = new Proxy(parent, {
        get: (target, key) =>
          key === "attribute"
            ? (name: string, value: unknown) => {
                if (name !== HIDDEN_ATTRIBUTE) target.attribute(name, value);
              }
            : Reflect.get(target, key, target),
      });
      return Context.add(context, Tracer.ParentSpan, filtered);
    }),
  );
