import React, { useEffect, useState } from 'react';
import styled, { keyframes } from 'styled-components';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
`;

const slideIn = keyframes`
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
`;

const pulse = keyframes`
  0% { transform: scale(1); }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); }
`;

const Overlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  animation: ${fadeIn} 0.3s ease-out;
`;

const Card = styled.div`
  background: #ffffff;
  padding: 32px;
  border-radius: 16px;
  width: 400px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  text-align: center;
  border: 1px solid #f1f5f9;
`;

const Banner = styled.div`
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: #ffffff;
  padding: 16px 20px;
  border-radius: 12px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  display: flex;
  align-items: center;
  gap: 16px;
  z-index: 9998;
  animation: ${slideIn} 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  border: 1px solid #e2e8f0;
`;

const Title = styled.h3`
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
`;

const Text = styled.p`
  margin: 4px 0 0;
  font-size: 14px;
  color: #64748b;
`;

const Button = styled.button`
  background: ${props => props.primary ? '#2563eb' : 'transparent'};
  color: ${props => props.primary ? '#ffffff' : '#64748b'};
  border: ${props => props.primary ? 'none' : '1px solid #e2e8f0'};
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: ${props => props.primary ? '#1d4ed8' : '#f8fafc'};
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }
`;

const ProgressBarContainer = styled.div`
  width: 100%;
  height: 8px;
  background: #f1f5f9;
  border-radius: 4px;
  margin: 24px 0 12px;
  overflow: hidden;
`;

const ProgressBarFill = styled.div`
  height: 100%;
  background: linear-gradient(90deg, #2563eb, #3b82f6);
  width: ${props => props.progress}%;
  transition: width 0.3s ease-out;
`;

const CheckMark = styled.div`
  width: 64px;
  height: 64px;
  background: #dcfce7;
  color: #16a34a;
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 0 auto 20px;
  font-size: 32px;
  animation: ${pulse} 2s infinite ease-in-out;
`;

const UpdateManager = () => {
  const [status, setStatus] = useState('idle'); // idle, available, downloading, ready
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState({ percent: 0, transferred: 0, total: 0 });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.updater) return;

    window.updater.onUpdateAvailable((info) => {
      setVersion(info.version);
      setStatus('available');
    });

    window.updater.onUpdateProgress((p) => {
      setProgress(p);
      setStatus('downloading');
    });

    window.updater.onUpdateDownloaded((info) => {
      setVersion(info.version);
      setStatus('ready');
    });

    window.updater.onUpdateError((err) => {
      console.error('Update error:', err);
      setError(err);
      // Optional: show error state or go back to idle
    });
  }, []);

  const handleStartUpdate = () => {
    window.updater.startUpdate();
    setStatus('downloading');
  };

  const handleRestart = () => {
    window.updater.restartAndInstall();
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (status === 'idle') return null;

  if (status === 'available') {
    return (
      <Banner>
        <div>
          <Title>Update Available</Title>
          <Text>Version {version} is ready to download.</Text>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button onClick={() => setStatus('idle')}>Later</Button>
          <Button primary onClick={handleStartUpdate}>Update Now</Button>
        </div>
      </Banner>
    );
  }

  if (status === 'downloading') {
    return (
      <Overlay>
        <Card>
          <Title>Downloading Update...</Title>
          <Text>Please wait while we prepare the new version.</Text>
          <ProgressBarContainer>
            <ProgressBarFill progress={progress.percent} />
          </ProgressBarContainer>
          <Text style={{ fontSize: '12px' }}>
            {formatBytes(progress.transferred)} of {formatBytes(progress.total)} ({Math.round(progress.percent)}%)
          </Text>
        </Card>
      </Overlay>
    );
  }

  if (status === 'ready') {
    return (
      <Overlay>
        <Card>
          <CheckMark>✓</CheckMark>
          <Title>Update Ready!</Title>
          <Text>Version {version} has been downloaded.</Text>
          <div style={{ marginTop: '24px' }}>
            <Button primary fullWidth style={{ width: '100%', padding: '12px' }} onClick={handleRestart}>
              Restart and Install
            </Button>
          </div>
        </Card>
      </Overlay>
    );
  }

  return null;
};

export default UpdateManager;
