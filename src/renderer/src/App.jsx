import { useEffect, useState } from 'react'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import UserPanel from './components/UserPanel'
import Maintenance from './components/Maintenance'
import UpdateManager from './components/UpdateManager'
import logo from './assets/logo.png'
import { Button, Skeleton, Snackbar } from '@mui/material'

function App() {
  const [loginUser, setLoginUser] = useState(undefined)
  const [authReady, setAuthReady] = useState(false)
  const [openSnack, setOpenSnack] = useState(false)
  const [snackMsg, setSnackMsg] = useState('')
  const [isMaintenance, setIsMaintenance] = useState(false)

  const snackMessage = (msg) => {
    setSnackMsg(msg)
    setOpenSnack(true)
  }

  const handleSnackClose = () => {
    setOpenSnack(false)
  }

  useEffect(() => {
    // FIX: store handler references so we can remove them on cleanup
    // prevents IPC listeners stacking up on every re-mount (memory leak)
    const handleCheckSession = (event, user) => {
      setLoginUser(user)
    }
    const handleMaintenanceMode = (event, maintenanceStatus) => {
      setIsMaintenance(maintenanceStatus)
    }

    if (typeof window !== 'undefined') {
      window.electron.ipcRenderer.on('check-session', handleCheckSession)
      window.electron.ipcRenderer.on('maintenance-mode', handleMaintenanceMode)
    }

    return () => {
      // FIX: remove listeners on cleanup to prevent memory leak
      if (typeof window !== 'undefined') {
        window.electron.ipcRenderer.removeListener('check-session', handleCheckSession)
        window.electron.ipcRenderer.removeListener('maintenance-mode', handleMaintenanceMode)
      }
    }
  }, [])

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        if (typeof window !== 'undefined') {
          const userData = await window.api.get('user')
          setLoginUser(userData ?? null)
          setAuthReady(true)
        }
      } catch (error) {
        console.error('Error fetching user data:', error)
        setAuthReady(true)
      }
    }

    fetchUserData()

    const intervalId = setInterval(fetchUserData, 10000)

    return () => {
      clearInterval(intervalId)
    }
  }, [])

  const logout = async () => {
    try {
      await window.electron.ipcRenderer.invoke('logout-activity')
    } catch (e) {
      console.error('Failed to log logout activity:', e)
    }
    await window.api.set('user', null)
    setLoginUser(null)
  }

  const checkLogin = async () => {
    const userData = await window.api.get('user')
    setLoginUser(userData)
  }

  return (
    <div className="min-h-screen flex text-black">
      <UpdateManager />
      <img alt="logo" className="logo" src={logo} />
      {!authReady ? (
        <div className="flex-1 flex items-center justify-center">
          <Skeleton variant="rectangular" width="80%" height="60%" sx={{ borderRadius: 2 }} />
        </div>
      ) : isMaintenance ? (
        <Maintenance />
      ) : loginUser === null ? (
        <Login checkLogin={checkLogin} />
      ) : loginUser !== undefined ? (
        // FIX: guard against loginUser still being undefined while authReady is settling
        <>
          {loginUser.role === 'admin' ? (
            <Dashboard logout={logout} loginUser={loginUser} snackMessage={snackMessage} />
          ) : (
            <UserPanel logout={logout} loginUser={loginUser} snackMessage={snackMessage} />
          )}
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <Skeleton variant="rectangular" width="80%" height="60%" sx={{ borderRadius: 2 }} />
        </div>
      )}
      <Snackbar
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        open={openSnack}
        onClose={handleSnackClose}
        message={snackMsg}
        action={
          <Button color="inherit" onClick={handleSnackClose}>
            X
          </Button>
        }
      />
    </div>
  )
}

export default App
