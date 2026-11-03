// 用户相关API接口

import { http } from '../../utils/request.ts'
import { API_CONFIG } from '../../config/api-config.js'
import { message } from '../../utils/message.js'

/**
 * 获取用户个人信息
 * @returns {Promise} 用户信息
 */
const _getUserProfile = async () => {
  try {
    const response = await http.get(API_CONFIG.endpoints.user.profile)
    
    if (response.code === 200 && response.data) {
      return {
        success: true,
        data: response.data,
        message: response.message || '获取用户信息成功'
      }
    } else {
      return {
        success: false,
        error: 'GET_PROFILE_FAILED',
        message: response.message || '获取用户信息失败'
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '获取用户信息失败，请稍后重试'
    }
  }
}

/**
 * 更新用户个人信息
 * @param {object} profileData 用户信息数据
 * @returns {Promise} 更新结果
 */
const _updateUserProfile = async (profileData) => {
  try {
    const response = await http.put('/user/profile', profileData)
    if (response.code === 200) {
      message.success('个人信息更新成功')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '更新个人信息失败'
    }
  }
}

/**
 * 上传用户头像
 * @param {File} avatarFile 头像文件
 * @returns {Promise} 上传结果
 */
const _uploadAvatar = async (avatarFile) => {
  try {
    const formData = new FormData()
    formData.append('avatar', avatarFile)
    
    const response = await http.post('/user/avatar', formData)
    if (response.code === 200) {
      message.success('头像上传成功')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '头像上传失败'
    }
  }
}

/**
 * 获取用户使用统计
 * @returns {Promise} 使用统计数据
 */
const _getUserStats = async () => {
  try {
    const response = await http.get('/user/stats')
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '获取使用统计失败'
    }
  }
}

/**
 * 获取用户订阅信息
 * @returns {Promise} 订阅信息
 */
const _getUserSubscription = async () => {
  try {
    const response = await http.get('/user/subscription')
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '获取订阅信息失败'
    }
  }
}

/**
 * 更新用户设置
 * @param {object} settings 设置数据
 * @returns {Promise} 更新结果
 */
const _updateUserSettings = async (settings) => {
  try {
    const response = await http.put('/user/settings', settings)
    if (response.code === 200) {
      message.success('设置更新成功')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '更新设置失败'
    }
  }
}

/**
 * 获取用户通知列表
 * @param {object} params 查询参数
 * @returns {Promise} 通知列表
 */
const _getUserNotifications = async (params = {}) => {
  try {
    const queryString = new URLSearchParams(params).toString()
    const url = `/user/notifications${queryString ? `?${queryString}` : ''}`
    
    const response = await http.get(url)
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '获取通知列表失败'
    }
  }
}

/**
 * 标记通知为已读
 * @param {number} notificationId 通知ID
 * @returns {Promise} 标记结果
 */
const _markNotificationAsRead = async (notificationId) => {
  try {
    const response = await http.put(`/user/notifications/${notificationId}/read`)
    if (response.code === 200) {
      message.success('通知已标记为已读')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '标记通知失败'
    }
  }
}

/**
 * 删除用户账户
 * @param {string} password 确认密码
 * @returns {Promise} 删除结果
 */
const _deleteUserAccount = async (password) => {
  try {
    const response = await http.delete('/user/account', { password })
    if (response.code === 200) {
      message.success('账户删除成功')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '删除账户失败'
    }
  }
}

/**
 * 修改密码
 * @param {object} passwordData 密码数据
 * @param {string} passwordData.currentPassword 当前密码
 * @param {string} passwordData.newPassword 新密码
 * @returns {Promise} 修改结果
 */
const _changePassword = async (passwordData) => {
  try {
    const response = await http.put('/user/password', passwordData)
    if (response.code === 200) {
      message.success('密码修改成功')
    }
    return {
      success: response.code === 200,
      data: response.data,
      message: response.message
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: '修改密码失败'
    }
  }
}

/**
 * 获取用户信息（getUserProfile的别名）
 * @returns {Promise} 用户信息
 */
export const getUserProfile = _getUserProfile
export const updateUserProfile = _updateUserProfile
export const uploadAvatar = _uploadAvatar
export const getUserStats = _getUserStats
export const getUserSubscription = _getUserSubscription
export const updateUserSettings = _updateUserSettings
export const getUserNotifications = _getUserNotifications
export const markNotificationAsRead = _markNotificationAsRead
export const deleteUserAccount = _deleteUserAccount
export const changePassword = _changePassword
