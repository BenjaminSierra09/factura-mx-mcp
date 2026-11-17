export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

export const LUNA_LOW_REASONING = { reasoning: { effort: 'low' as const } };

export function assertOpenAIResponseCompleted(
  response: { status?: string; incomplete_details?: { reason?: string | null } | null },
  task: string,
): void {
  if (response.status === 'completed') return;
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
    throw new Error(`${task}: OpenAI agotó el límite de salida antes de terminar.`);
  }
  throw new Error(`${task}: OpenAI no completó la respuesta.`);
}
