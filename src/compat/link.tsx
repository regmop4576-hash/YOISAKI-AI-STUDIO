import type {AnchorHTMLAttributes} from 'react';
import {navigate} from './navigation';
export default function Link({href='',onClick,...props}:AnchorHTMLAttributes<HTMLAnchorElement>){return <a {...props} href={href} onClick={e=>{onClick?.(e);if(!e.defaultPrevented&&e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&!props.target&&href.startsWith('/')){e.preventDefault();navigate(href)}}}/>}
