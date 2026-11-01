export type LoraTags={model_id:string;trigger_words:string[];recommended_tags:string[]};
export function parseTags(value:string):string[]{return Array.from(new Set(value.split(/[,\n\r]+/).map(x=>x.trim()).filter(Boolean)));}
export function joinTags(tags:LoraTags[]):string[]{return Array.from(new Set(tags.flatMap(t=>[...t.trigger_words,...t.recommended_tags])));}
export function appendTags(prompt:string,tags:string[]):string {const existing=new Set(parseTags(prompt).map(x=>x.toLowerCase()));const add=tags.filter(t=>{const key=t.toLowerCase();if(existing.has(key))return false;existing.add(key);return true});return [prompt.trim().replace(/,\s*$/,''),...add].filter(Boolean).join(', ');}
export function selectedTags(stack:{id:string;enabled:boolean}[],metadata:Record<string,LoraTags>){return stack.filter(x=>x.enabled).map(x=>metadata[x.id]).filter((x):x is LoraTags=>Boolean(x));}
