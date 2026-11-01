export type ControlMap={image:string;type:string;width:number;height:number;key:string;preprocessor?:string};
export const posePreprocessors=[['openpose','OpenPose Classic'],['sdpose','SDPose-OOD']] as const;
export function posePreprocessor(type:string,value:string|undefined){return type==='OpenPose'?(value==='sdpose'?'sdpose':'openpose'):''}
// v1.6.2: the pose preprocessor is part of the key, so switching it invalidates a stale prepared map.
export function controlKey(type:string,width:number,height:number,prepared:boolean,revision:number,preprocessor=''){return JSON.stringify([type,width,height,prepared,revision,preprocessor])}
export function controlError(s:{controlEnabled:boolean;controlType:string;controlStrength:number;controlStart:number;controlEnd:number},map:ControlMap|null,key:string,regional:boolean){
 if(!s.controlEnabled)return '';
 if(regional)return 'Одновременная работа Regional Control и ControlNet пока не поддерживается.';
 if(![s.controlStrength,s.controlStart,s.controlEnd].every(Number.isFinite)||s.controlStrength<0||s.controlStrength>2||s.controlStart<0||s.controlStart>=s.controlEnd||s.controlEnd>1)return 'ControlNet: требуется Strength 0–2 и 0 ≤ Start < End ≤ 1.';
 if(!map||map.key!==key||map.type!==s.controlType)return 'Загрузите изображение и подготовьте карту ControlNet.';
 return '';
}
export function readControlFile(file:File):Promise<string>{
 if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>6*1024*1024)return Promise.reject(Error('Нужен PNG, JPEG или WebP до 6 МБ.'));
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('Не удалось прочитать изображение.'));reader.readAsDataURL(file)});
}
