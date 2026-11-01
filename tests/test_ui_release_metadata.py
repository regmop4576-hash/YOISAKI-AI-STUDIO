"""Actual FastAPI application, no GPU required; engine/API versions remain 1.7.0."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from fastapi.testclient import TestClient
from worker.direct_server import create_app

def test_engine_api_metadata_and_auth(tmp_path):
    token='d'*64
    app=create_app(tmp_path,token)
    assert app.version=='1.7.0'
    with TestClient(app) as client:
        assert client.get('/health').status_code==401
        assert client.get('/health',headers={'Authorization':'Bearer '+'e'*64}).status_code==401
        response=client.get('/health',headers={'Authorization':'Bearer '+token})
        assert response.status_code==200
        health=response.json()
        assert health['engine_version']=='1.7.0'
        assert health['api_version']=='1.7.0'
        assert health['capabilities']['img2img'] is True
        assert token not in response.text
