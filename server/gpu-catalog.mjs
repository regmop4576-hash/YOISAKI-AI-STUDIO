// v1.7.7 reference data for GPU offers: compute capability (CUDA "sm") and the VRAM sizes the vendor ships.
// Used only for WARNINGS and for the documented PyTorch kernel range; an unknown GPU name is never rejected: its
// compatibility is judged by the API's VRAM/CUDA fields and verified by the engine's GPU check at start.
//
// YOISAKI ENGINE image torch 2.10.0+cu128 kernels (measured in the image build, cloudcompute/import_check.py):
//   sm_70 sm_75 sm_80 sm_86 sm_90 sm_100 sm_120, no PTX. CUDA binary compatibility runs sm_86 code on sm_89 (Ada).
export const TORCH_ARCH=['sm_70','sm_75','sm_80','sm_86','sm_90','sm_100','sm_120'];

// [pattern on the normalized name, model label, compute capability, VRAM sizes in GB]. Order: specific before generic.
const MODELS=[
 [/\b4090\s?d\b/,'RTX 4090 D','8.9',[24]],[/\b4090\b/,'RTX 4090','8.9',[24]],
 [/\b4080\s?super\b/,'RTX 4080 SUPER','8.9',[16]],[/\b4080\b/,'RTX 4080','8.9',[16]],
 [/\b4070\s?ti\s?super\b/,'RTX 4070 Ti SUPER','8.9',[16]],[/\b4070\b/,'RTX 4070 family','8.9',[12]],
 [/\b4060\s?ti\b/,'RTX 4060 Ti','8.9',[8,16]],[/\b4060\b/,'RTX 4060','8.9',[8]],
 [/\b3090\s?ti\b/,'RTX 3090 Ti','8.6',[24]],[/\b3090\b/,'RTX 3090','8.6',[24]],
 [/\b3080\s?ti\b/,'RTX 3080 Ti','8.6',[12]],[/\b3080\b/,'RTX 3080','8.6',[10,12]],
 [/\b3070\b/,'RTX 3070 family','8.6',[8]],[/\b3060\s?ti\b/,'RTX 3060 Ti','8.6',[8]],[/\b3060\b/,'RTX 3060','8.6',[8,12]],
 [/\b5090\b/,'RTX 5090','12.0',[32]],[/\b5080\b/,'RTX 5080','12.0',[16]],[/\b5070\s?ti\b/,'RTX 5070 Ti','12.0',[16]],
 [/\b5070\b/,'RTX 5070','12.0',[12]],[/\b5060\s?ti\b/,'RTX 5060 Ti','12.0',[8,16]],[/\b5060\b/,'RTX 5060','12.0',[8]],
 [/\bpro\s?6000\b.*blackwell|blackwell.*\bpro\s?6000\b/,'RTX PRO 6000 Blackwell','12.0',[96]],
 [/\b2080\s?ti\b/,'RTX 2080 Ti','7.5',[11]],[/\btitan\s?rtx\b/,'TITAN RTX','7.5',[24]],[/\b2080\b/,'RTX 2080','7.5',[8]],
 [/\bt4\b/,'Tesla T4','7.5',[16]],[/\bv100s?\b/,'Tesla V100','7.0',[16,32]],
 [/\bp100\b/,'Tesla P100','6.0',[12,16]],[/\bp40\b/,'Tesla P40','6.1',[24]],[/\bp4\b/,'Tesla P4','6.1',[8]],[/\b10[6-8]0\b/,'GTX 10xx','6.1',[3,6,8,11]],
 [/\ba100\b/,'A100','8.0',[40,80]],[/\ba800\b/,'A800','8.0',[40,80]],[/\ba30\b/,'A30','8.0',[24]],
 [/\ba10g\b/,'A10G','8.6',[24]],[/\ba10\b/,'A10','8.6',[24]],[/\ba40\b/,'A40','8.6',[48]],[/\ba16\b/,'A16','8.6',[16]],[/\ba2\b/,'A2','8.6',[16]],
 [/\b(rtx\s?)?a6000\b/,'RTX A6000','8.6',[48]],[/\b(rtx\s?)?a5000\b/,'RTX A5000','8.6',[24]],[/\b(rtx\s?)?a4500\b/,'RTX A4500','8.6',[20]],[/\b(rtx\s?)?a4000\b/,'RTX A4000','8.6',[16]],
 [/\b6000\s?ada\b/,'RTX 6000 Ada','8.9',[48]],[/\b5000\s?ada\b/,'RTX 5000 Ada','8.9',[32]],[/\b4000\s?ada\b/,'RTX 4000 Ada','8.9',[20]],
 [/\bl40s\b/,'L40S','8.9',[48]],[/\bl40\b/,'L40','8.9',[48]],[/\bl4\b/,'L4','8.9',[24]],
 [/\bh200\b/,'H200','9.0',[141]],[/\bgh200\b/,'GH200','9.0',[96,144]],[/\bh100\b/,'H100','9.0',[80,94,96]],[/\bh800\b/,'H800','9.0',[80]],
 [/\bb200\b/,'B200','10.0',[180,192]],
];
const normalize=name=>String(name||'').toLowerCase().replace(/nvidia|geforce|tesla|quadro/g,' ').replace(/[_-]/g,' ').replace(/\s+/g,' ').trim();
export function gpuModel(name){
 const n=normalize(name);
 for(const [re,label,cc,vram] of MODELS)if(re.test(n))return {known:true,label,cc,vram_gb:vram,name_vram_gb:Number(n.match(/\b(\d{1,3})\s?gb?\b/)?.[1])||null};
 return {known:false,label:'',cc:null,vram_gb:[],name_vram_gb:Number(n.match(/\b(\d{1,3})\s?gb?\b/)?.[1])||null};
}
// Same rule as cloudcompute/diagnose.py arch_supported(): native SASS, or SASS of the same major and a lower minor.
export function kernelsFor(cc,arch=TORCH_ARCH){
 if(!cc)return null;
 const [major,minor]=cc.split('.').map(Number),cap=major*10+minor;
 return arch.includes('sm_'+cap)||arch.some(a=>{const v=Number(a.slice(3));return /^sm_\d+$/.test(a)&&Math.floor(v/10)===major&&v%10<=minor});
}
// Reported VRAM is usually slightly below the nominal size (e.g. T4 16 GB → 15 360 MiB).
const near=(mb,gb)=>mb>=gb*1024*0.9&&mb<=gb*1024*1.05;
// {reasons, warnings} for one offer. Warnings never hide an offer; reasons are only documented incompatibilities.
export function gpuAssessment({gpu,gpus=1,vram_mb}){
 const m=gpuModel(gpu),reasons=[],warnings=[];
 if(!m.known)warnings.push('Модель GPU не распознана по названию: совместимость оценивается по VRAM/CUDA из API, окончательно — проверкой GPU при запуске движка.');
 else{
  if(kernelsFor(m.cc)===false)reasons.push(`${m.label} (sm_${m.cc.replace('.','')}): в PyTorch образа нет ядер для этой архитектуры (есть ${TORCH_ARCH.join(' ')}).`);
  else if(m.cc==='8.9')warnings.push(`${m.label} (sm_89): ядра sm_86 по двоичной совместимости CUDA; поддерживается начиная с образа 1.7.7.`);
  else if(m.cc==='7.0')warnings.push(`${m.label} (Volta, sm_70): нет bf16 и Flash Attention, генерация медленнее; fp16 работает.`);
  if(vram_mb!=null&&m.vram_gb.length&&!m.vram_gb.some(g=>near(vram_mb,g))){
   const total=gpus>1&&m.vram_gb.some(g=>near(vram_mb,g*gpus));
   warnings.push(total?`VRAM ${Math.round(vram_mb/1024)} ГБ похоже на сумму ${gpus} GPU: на одну карту ${m.vram_gb.join('/')} ГБ.`
    :`Нестандартный объём VRAM: заявлено ${Math.round(vram_mb/1024)} ГБ, у ${m.label} обычно ${m.vram_gb.join('/')} ГБ. Возможна модифицированная карта или ошибка данных; фактический объём проверит движок при запуске.`);
  }
 }
 if(m.name_vram_gb&&vram_mb!=null&&!near(vram_mb,m.name_vram_gb)&&!(gpus>1&&near(vram_mb,m.name_vram_gb*gpus)))warnings.push(`Название указывает ${m.name_vram_gb} ГБ, а API — ${Math.round(vram_mb/1024)} ГБ VRAM.`);
 return {model:m.known?{label:m.label,cc:m.cc,vram_gb:m.vram_gb}:null,reasons,warnings};
}
