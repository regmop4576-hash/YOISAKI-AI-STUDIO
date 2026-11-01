"""Literal SDXL long prompts; no weighting parser, rewriting or embedding cache.

75 content IDs per 77-position CLIP window (or tokenizer's native window).
Both encoders and CFG branches are padded with encoded empty windows. Pooled
conditioning is the SECOND encoder's FIRST window projection, matching native
SDXL for short prompts. This policy is explicit, not a Civitai equivalence claim.
"""
import math

MAX_CHUNKS = 16

class PromptEncodingError(ValueError):
    pass


def token_plan(pipe, prompt, negative_prompt='', include_text=False):
    result = {'mode': 'literal-chunks-v1', 'pooled_policy': 'encoder_2_first_chunk', 'encoders': []}
    for tokenizer in (pipe.tokenizer, pipe.tokenizer_2):
        limit = tokenizer.model_max_length
        capacity = limit - 2
        row = {'window': limit, 'content_capacity': capacity}
        for label, text in [('positive', prompt), ('negative', negative_prompt)]:
            ids = tokenizer(text, add_special_tokens=False, truncation=False).input_ids
            item = {'content_tokens': len(ids), 'native_processed_content_tokens': min(len(ids), capacity),
                    'native_discarded_tokens': max(0, len(ids)-capacity),
                    'chunks': max(1, math.ceil(len(ids)/capacity)), 'processed_content_tokens': len(ids)}
            if include_text:
                # Exact discarded token IDs; decoded boundary can be a partial word.
                item.update(native_discarded_ids=ids[capacity:], native_discarded_text=tokenizer.decode(ids[capacity:]))
            row[label] = item
        result['encoders'].append(row)
    result['chunks'] = max(r[k]['chunks'] for r in result['encoders'] for k in ('positive', 'negative'))
    if result['chunks'] > MAX_CHUNKS:
        raise PromptEncodingError(f'Prompt requires {result["chunks"]} CLIP chunks; supported maximum is {MAX_CHUNKS}. Nothing was truncated.')
    return result


def encode_long_prompt(pipe, prompt, negative_prompt='', *, device=None,
                       num_images_per_prompt=1, do_classifier_free_guidance=True):
    import torch
    device = device or pipe._execution_device
    plan = token_plan(pipe, prompt, negative_prompt)
    # Preserve the library's exact short-prompt behavior (including empty negative).
    if plan['chunks'] == 1:
        return pipe.encode_prompt(prompt=prompt, negative_prompt=negative_prompt, device=device,
                                  num_images_per_prompt=num_images_per_prompt,
                                  do_classifier_free_guidance=do_classifier_free_guidance)
    branches = [prompt, negative_prompt] if do_classifier_free_guidance else [prompt]
    hidden = [[] for _ in branches]
    pooled = [None for _ in branches]
    with torch.no_grad():
        # Encoder-major traversal avoids bouncing the two CPU offload hooks per chunk.
        for index, (tokenizer, encoder) in enumerate(zip(
                (pipe.tokenizer, pipe.tokenizer_2), (pipe.text_encoder, pipe.text_encoder_2))):
            limit = tokenizer.model_max_length
            if limit != pipe.tokenizer.model_max_length:
                raise PromptEncodingError('SDXL encoders must have equal CLIP window lengths')
            capacity = limit - 2
            for branch, text in enumerate(branches):
                ids = tokenizer(text, add_special_tokens=False, truncation=False).input_ids
                chunks = []
                for start in range(plan['chunks']):
                    content = ids[start*capacity:(start+1)*capacity]
                    window = [tokenizer.bos_token_id] + content + [tokenizer.eos_token_id]
                    window += [tokenizer.pad_token_id] * (limit-len(window))
                    tokens = torch.tensor([window], dtype=torch.long, device=device)
                    output = encoder(tokens, output_hidden_states=True)
                    chunks.append(output.hidden_states[-2])
                    if index == 1 and start == 0:
                        pooled[branch] = output.text_embeds
                    del output
                hidden[branch].append(torch.cat(chunks, dim=1))
    dtype = pipe.text_encoder_2.dtype
    embeddings = [torch.cat(parts, dim=-1).to(device=device, dtype=dtype) for parts in hidden]
    embeddings = [x.repeat_interleave(num_images_per_prompt, dim=0) for x in embeddings]
    pooled = [x.to(device=device, dtype=dtype).repeat_interleave(num_images_per_prompt, dim=0) for x in pooled]
    if do_classifier_free_guidance:
        assert embeddings[0].shape == embeddings[1].shape
        return embeddings[0], embeddings[1], pooled[0], pooled[1]
    return embeddings[0], None, pooled[0], None


def embedding_kwargs(pipe, req):
    values = encode_long_prompt(pipe, req['prompt'], req.get('negative_prompt', ''),
                               do_classifier_free_guidance=req['cfg_scale'] > 1)
    return dict(zip(('prompt_embeds', 'negative_prompt_embeds',
                     'pooled_prompt_embeds', 'negative_pooled_prompt_embeds'), values))
