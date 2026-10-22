import './globals.css';import type {Metadata} from 'next';import {Shell} from '@/components/Shell';
export const metadata:Metadata={title:'YOISAKI AI STUDIO',description:'Amber Core creative studio prototype'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body><Shell>{children}</Shell></body></html>}
