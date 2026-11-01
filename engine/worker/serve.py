"""Run in the isolated inference interpreter; token is never a CLI argument."""
import os
import uvicorn
from worker.direct_server import create_app
if __name__=='__main__':
    uvicorn.run(create_app(os.environ['YOISAKI_MODEL_ROOT'],os.environ['YOISAKI_TOKEN']),
        host='127.0.0.1',port=int(os.environ.get('YOISAKI_PORT','8765')),access_log=False,log_level='warning')
