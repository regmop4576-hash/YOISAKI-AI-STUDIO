export type ModelKind='checkpoint'|'lora'|'vae'|'controlnet';
export interface DemoModel{id:string;name:string;kind:ModelKind;architecture:string;extension:string;size:string;trigger?:string;compatibility:string;description:string}
/** Populated only by the future verified GPU engine adapter; never display fabricated models. */
export const demoModels:DemoModel[]=[];
